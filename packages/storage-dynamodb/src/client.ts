import { AppError } from "@ai-moves/kernel/errors/app-error";

import type { DynamoDbApi, DynamoDbOperation, DynamoDbResult } from "./api.ts";
import {
  type Attributes,
  isRecord,
  itemBytes,
  MAX_ITEM_BYTES,
  marshal,
  unmarshal,
} from "./codec.ts";
import type { Key } from "./keys.ts";
import {
  type IndexName,
  indexPartitionKey,
  indexSortKey,
  PARTITION_KEY,
  SORT_KEY,
} from "./tables.ts";

export const MAX_TRANSACTION_ITEMS = 100;

// Every record carries an optimistic version `rev`; a write conditions on the version it read.
export type Condition =
  | { readonly kind: "absent" }
  | { readonly kind: "exists" }
  | { readonly kind: "rev"; readonly rev: number };

export const ABSENT: Condition = { kind: "absent" };
export const EXISTS: Condition = { kind: "exists" };

export function revCondition(rev: number | null): Condition {
  return rev === null ? ABSENT : { kind: "rev", rev };
}

export type WriteOp =
  | { readonly kind: "put"; readonly item: Attributes; readonly condition?: Condition }
  | { readonly kind: "delete"; readonly key: Key; readonly condition?: Condition }
  | { readonly kind: "check"; readonly key: Key; readonly condition: Condition };

// `condition`: a condition was false (indexes name the operations whose condition failed).
// `conflict`: another transaction touched an item; the write may succeed if re-evaluated.
export type WriteOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "condition"; readonly failed: readonly number[] }
  | { readonly kind: "conflict" };

export interface RangeCondition {
  readonly op: "<" | ">=" | "begins_with" | "between";
  readonly value: string;
  readonly upper?: string;
}

export interface QuerySpec {
  readonly index?: IndexName;
  readonly partition: string;
  readonly range?: RangeCondition;
  readonly descending?: boolean;
}

const CONFLICT_TYPES = new Set(["TransactionConflictException"]);
const RETRYABLE_REASONS = new Set(["TransactionConflict"]);

export function storageUnavailable(
  operation: string,
  detail: { readonly type?: string; readonly status?: number; readonly cause?: unknown } = {},
): AppError {
  return new AppError("STORAGE_UNAVAILABLE", {
    message: `DynamoDB ${operation} failed${detail.type === undefined ? "" : `: ${detail.type}`}`,
    cause: detail.cause,
    context: {
      operation,
      ...(detail.type === undefined ? {} : { type: detail.type }),
      ...(detail.status === undefined ? {} : { status: detail.status }),
    },
  });
}

function conditionExpression(condition: Condition): {
  readonly expression: string;
  readonly names: Record<string, string>;
  readonly values?: Record<string, unknown>;
} {
  if (condition.kind === "absent") {
    return { expression: "attribute_not_exists(#pk)", names: { "#pk": PARTITION_KEY } };
  }
  if (condition.kind === "exists") {
    return { expression: "attribute_exists(#pk)", names: { "#pk": PARTITION_KEY } };
  }
  return {
    expression: "#rev = :rev",
    names: { "#rev": "rev" },
    values: marshal({ ":rev": condition.rev }),
  };
}

function conditionInput(condition: Condition | undefined): Record<string, unknown> {
  if (condition === undefined) return {};
  const { expression, names, values } = conditionExpression(condition);
  return {
    ConditionExpression: expression,
    ExpressionAttributeNames: names,
    ...(values === undefined ? {} : { ExpressionAttributeValues: values }),
  };
}

function assertItemSize(item: Attributes): void {
  // A record past the limit can never be written, so retrying it as STORAGE_UNAVAILABLE would only
  // burn attempts; it is the caller's input that does not fit.
  if (itemBytes(item) > MAX_ITEM_BYTES) {
    throw new AppError("INPUT_INVALID", {
      message: "Record exceeds the DynamoDB item size limit",
      context: { limit_bytes: MAX_ITEM_BYTES },
    });
  }
}

function keyOf(key: Key): Record<string, unknown> {
  return marshal({ [PARTITION_KEY]: key.pk, [SORT_KEY]: key.sk });
}

function cancellationCodes(body: Readonly<Record<string, unknown>>): readonly string[] | null {
  const reasons = body["CancellationReasons"];
  if (!Array.isArray(reasons)) return null;
  return reasons.map((reason: unknown) => {
    const code = isRecord(reason) ? reason["Code"] : undefined;
    return typeof code === "string" ? code : "";
  });
}

export interface TableClient {
  get(key: Key): Promise<Attributes | null>;
  queryPage(
    spec: QuerySpec,
    limit: number | undefined,
    start: unknown,
  ): Promise<{ readonly items: readonly Attributes[]; readonly next: unknown }>;
  collect<T>(
    spec: QuerySpec,
    want: number,
    accept: (attributes: Attributes) => T | null,
    pageSize?: number,
  ): Promise<T[]>;
  put(item: Attributes, condition?: Condition): Promise<WriteOutcome>;
  delete(key: Key, condition?: Condition): Promise<WriteOutcome>;
  transact(operations: readonly WriteOp[]): Promise<WriteOutcome>;
}

export function createTableClient(api: DynamoDbApi, tableName: string): TableClient {
  async function request(
    operation: DynamoDbOperation,
    input: Readonly<Record<string, unknown>>,
  ): Promise<DynamoDbResult> {
    try {
      return await api.call(operation, input);
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw storageUnavailable(operation, { cause });
    }
  }

  async function succeed(
    operation: DynamoDbOperation,
    input: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const result = await request(operation, input);
    if (result.ok) return result.body;
    throw storageUnavailable(operation, { type: result.type, status: result.status });
  }

  async function write(
    operation: DynamoDbOperation,
    input: Readonly<Record<string, unknown>>,
  ): Promise<WriteOutcome> {
    const result = await request(operation, input);
    if (result.ok) return { kind: "ok" };
    if (result.type === "ConditionalCheckFailedException")
      return { kind: "condition", failed: [0] };
    if (CONFLICT_TYPES.has(result.type)) return { kind: "conflict" };
    if (result.type === "TransactionCanceledException") {
      const codes = cancellationCodes(result.body);
      if (codes !== null) {
        const failed = codes.flatMap((code, index) =>
          code === "ConditionalCheckFailed" ? [index] : [],
        );
        if (failed.length > 0) return { kind: "condition", failed };
        if (codes.every((code) => code === "None" || RETRYABLE_REASONS.has(code))) {
          return { kind: "conflict" };
        }
      }
    }
    // Throttling, 5xx, and validation failures are all reported as retryable storage failures, as
    // the D1 adapter does; the size check above catches the one validation failure a caller causes.
    throw storageUnavailable(operation, { type: result.type, status: result.status });
  }

  async function queryPage(
    spec: QuerySpec,
    limit: number | undefined,
    start: unknown,
  ): Promise<{ readonly items: readonly Attributes[]; readonly next: unknown }> {
    const partitionName = spec.index === undefined ? PARTITION_KEY : indexPartitionKey(spec.index);
    const sortName = spec.index === undefined ? SORT_KEY : indexSortKey(spec.index);
    const values: Record<string, string> = { ":p": spec.partition };
    let keyCondition = "#p = :p";
    const range = spec.range;
    if (range !== undefined) {
      values[":v"] = range.value;
      if (range.op === "begins_with") keyCondition += " AND begins_with(#s, :v)";
      else if (range.op === "between") {
        values[":u"] = range.upper ?? range.value;
        keyCondition += " AND #s BETWEEN :v AND :u";
      } else keyCondition += ` AND #s ${range.op} :v`;
    }
    const body = await succeed("Query", {
      TableName: tableName,
      ...(spec.index === undefined ? { ConsistentRead: true } : { IndexName: spec.index }),
      KeyConditionExpression: keyCondition,
      ExpressionAttributeNames: {
        "#p": partitionName,
        ...(range === undefined ? {} : { "#s": sortName }),
      },
      ExpressionAttributeValues: marshal(values),
      ScanIndexForward: spec.descending !== true,
      ...(limit === undefined ? {} : { Limit: limit }),
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    });
    const items = body["Items"];
    if (!Array.isArray(items)) throw storageUnavailable("Query", { type: "MalformedResponse" });
    return { items: items.map(unmarshal), next: body["LastEvaluatedKey"] };
  }

  return {
    async get(key) {
      const body = await succeed("GetItem", {
        TableName: tableName,
        Key: keyOf(key),
        ConsistentRead: true,
      });
      return body["Item"] === undefined ? null : unmarshal(body["Item"]);
    },
    queryPage,
    async collect<T>(
      spec: QuerySpec,
      want: number,
      accept: (attributes: Attributes) => T | null,
      pageSize?: number,
    ): Promise<T[]> {
      const rows: T[] = [];
      if (!(want > 0)) return rows;
      let start: unknown;
      do {
        // `Limit` counts items read before `accept` filters them, so a filtered read pages on.
        const remaining = want - rows.length;
        const limit = Number.isFinite(remaining) ? Math.max(remaining, pageSize ?? 0) : pageSize;
        const page = await queryPage(spec, limit, start);
        for (const item of page.items) {
          const row = accept(item);
          if (row !== null) rows.push(row);
          if (rows.length >= want) break;
        }
        start = page.next;
      } while (start !== undefined && rows.length < want);
      return rows;
    },
    async put(item, condition) {
      assertItemSize(item);
      return write("PutItem", {
        TableName: tableName,
        Item: marshal(item),
        ...conditionInput(condition),
      });
    },
    async delete(key, condition) {
      return write("DeleteItem", {
        TableName: tableName,
        Key: keyOf(key),
        ...conditionInput(condition),
      });
    },
    async transact(operations) {
      if (operations.length === 0) return { kind: "ok" };
      // The service rejects larger transactions outright; every caller sizes its batch first.
      if (operations.length > MAX_TRANSACTION_ITEMS) {
        throw new AppError("INPUT_INVALID", {
          message: `A DynamoDB transaction holds at most ${MAX_TRANSACTION_ITEMS} items`,
          context: { items: operations.length },
        });
      }
      const transactItems = operations.map((operation) => {
        if (operation.kind === "put") {
          assertItemSize(operation.item);
          return {
            Put: {
              TableName: tableName,
              Item: marshal(operation.item),
              ...conditionInput(operation.condition),
            },
          };
        }
        const target = {
          TableName: tableName,
          Key: keyOf(operation.key),
          ...conditionInput(operation.condition),
        };
        return operation.kind === "delete" ? { Delete: target } : { ConditionCheck: target };
      });
      return write("TransactWriteItems", { TransactItems: transactItems });
    },
  };
}

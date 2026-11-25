import {
  StorageLimitSchema,
  type Inserted,
  type StaleQuery,
} from "@ai-moves/contracts/ports/storage";
import type { EntityId, EpochMs } from "@ai-moves/contracts/primitives";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { compareId } from "@ai-moves/storage/rules";

import type { DynamoDbApi } from "./api.ts";
import {
  ABSENT,
  createTableClient,
  storageUnavailable,
  type QuerySpec,
  type WriteOp,
  type WriteOutcome,
} from "./client.ts";
import type { Attributes } from "./codec.ts";
import { type Key, keys, pad, RANGE_END } from "./keys.ts";
import {
  decodeGate,
  decodeLedger,
  type Loaded,
  loaded,
  markerRecord,
  markerRef,
} from "./records.ts";

export const DEFAULT_MAX_ATTEMPTS = 8;
const FILTERED_PAGE_SIZE = 100;
export const RETRY: unique symbol = Symbol("retry");
export type Attempt<T> = Promise<T | typeof RETRY>;

function toStorageError(cause: unknown): AppError {
  if (cause instanceof AppError) return cause;
  return new AppError("STORAGE_UNAVAILABLE", { cause });
}

export async function execute<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw toStorageError(cause);
  }
}

export function inserted<T>(value: T, created: boolean): Inserted<T> {
  return { value, created };
}

export function compareCreated<T extends { created_at: EpochMs; id: EntityId }>(
  left: T,
  right: T,
): number {
  return left.created_at - right.created_at || compareId(left.id, right.id);
}

export function compareUpdated<T extends { state_updated_at: EpochMs; id: EntityId }>(
  left: T,
  right: T,
): number {
  return left.state_updated_at - right.state_updated_at || compareId(left.id, right.id);
}

// The padded sort-key prefix below which every epoch is `< value`, or null for an empty range.
export function epochsBelow(value: number): string | null {
  if (Number.isNaN(value)) return null;
  const bound = Math.ceil(value);
  if (bound <= 0) return null;
  return bound > Number.MAX_SAFE_INTEGER ? RANGE_END : pad(bound);
}

export function positiveLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.floor(limit) : 0;
}

export function settled<T>(outcome: WriteOutcome, value: T): T | typeof RETRY {
  return outcome.kind === "ok" ? value : RETRY;
}

export function requireNoConflict(outcome: WriteOutcome, operation: string): void {
  if (outcome.kind === "conflict") {
    throw storageUnavailable(operation, { type: "TransactionConflict" });
  }
}

export function createContext(api: DynamoDbApi, tableName: string, maxAttempts: number) {
  const table = createTableClient(api, tableName);

  // The DynamoDB counterpart of a conditional SQL UPDATE: read, decide in TypeScript, write under
  // the version read, and re-decide if anything wrote the record in between. Only a predicate that
  // is false after a fresh read makes the operation fail.
  async function optimistic<T>(attempt: () => Attempt<T>): Promise<T> {
    for (let count = 0; count < maxAttempts; count += 1) {
      const result = await attempt();
      if (result !== RETRY) return result;
    }
    throw new AppError("STORAGE_UNAVAILABLE", {
      message: "Optimistic concurrency retries exhausted",
      context: { attempts: maxAttempts },
    });
  }

  async function commit(operations: readonly WriteOp[]): Promise<WriteOutcome> {
    const [only] = operations;
    if (operations.length === 1 && only?.kind === "put")
      return table.put(only.item, only.condition);
    return table.transact(operations);
  }

  async function load<T>(
    key: Key,
    decode: (attributes: Attributes) => T,
  ): Promise<Loaded<T> | null> {
    const row = await table.get(key);
    return row === null ? null : loaded(row, decode);
  }

  async function read<T>(key: Key, decode: (attributes: Attributes) => T): Promise<T | null> {
    const row = await table.get(key);
    return row === null ? null : decode(row);
  }

  async function queryAll<T>(spec: QuerySpec, decode: (attributes: Attributes) => T): Promise<T[]> {
    return table.collect(spec, Number.POSITIVE_INFINITY, decode);
  }

  async function resolveMarker<T>(
    marker: Key,
    keyOf: (id: EntityId) => Key,
    decode: (attributes: Attributes) => T,
  ): Promise<Loaded<T> | null> {
    const markerRow = await table.get(marker);
    if (markerRow === null) return null;
    const row = await table.get(keyOf(markerRef(markerRow)));
    if (row === null) {
      throw new AppError("ROW_INVALID", {
        message: "Unique key marker points at a missing record",
        context: { marker: marker.pk },
      });
    }
    return loaded(row, decode);
  }

  async function insertUnique(
    record: Attributes,
    marker: Key,
    id: EntityId,
  ): Promise<WriteOutcome> {
    return table.transact([
      { kind: "put", item: record, condition: ABSENT },
      { kind: "put", item: markerRecord(marker, id), condition: ABSENT },
    ]);
  }

  async function loadGate() {
    return decodeGate(await table.get(keys.sendGate));
  }

  async function loadLedger(itemId: EntityId) {
    return decodeLedger(await table.get(keys.updateLedger(itemId)));
  }

  async function staleRows<
    T extends { state_updated_at: EpochMs; id: EntityId; next_attempt_at: EpochMs | null },
    State extends string,
  >(
    query: StaleQuery<State>,
    partitionOf: (state: State) => string,
    decode: (attributes: Attributes) => T,
  ): Promise<readonly T[]> {
    const bounded = parseBoundary(StorageLimitSchema, query.limit, "INPUT_INVALID");
    if (query.states.length === 0) return [];
    return execute(async () => {
      const below = epochsBelow(query.updatedBefore);
      if (below === null) return [];
      const { readyAt } = query;
      const accept = (attributes: Attributes): T | null => {
        const row = decode(attributes);
        return readyAt === undefined ||
          row.next_attempt_at === null ||
          row.next_attempt_at <= readyAt
          ? row
          : null;
      };
      const perState = await Promise.all(
        [...new Set(query.states)].map((state) =>
          table.collect(
            { index: "gsi3", partition: partitionOf(state), range: { op: "<", value: below } },
            bounded,
            accept,
            readyAt === undefined ? undefined : FILTERED_PAGE_SIZE,
          ),
        ),
      );
      return perState.flat().toSorted(compareUpdated).slice(0, bounded);
    });
  }

  return {
    table,
    optimistic,
    commit,
    load,
    read,
    queryAll,
    resolveMarker,
    insertUnique,
    loadGate,
    loadLedger,
    staleRows,
  };
}

export type StorageContext = ReturnType<typeof createContext>;

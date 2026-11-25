// The slice of the DynamoDB JSON API the adapter calls. The composition root supplies a signed
// transport; the adapter never opens a connection itself.
export type DynamoDbOperation =
  | "BatchWriteItem"
  | "DeleteItem"
  | "GetItem"
  | "PutItem"
  | "Query"
  | "TransactGetItems"
  | "TransactWriteItems"
  | "UpdateItem";

// A response the service answered. `type` is the exception name with its namespace removed
// (`ConditionalCheckFailedException`); a transport failure rejects instead of resolving.
export type DynamoDbResult =
  | { readonly ok: true; readonly body: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly status: number;
      readonly type: string;
      readonly body: Readonly<Record<string, unknown>>;
    };

export interface DynamoDbApi {
  call(
    operation: DynamoDbOperation,
    input: Readonly<Record<string, unknown>>,
  ): Promise<DynamoDbResult>;
}

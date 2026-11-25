// The single table every repository shares, as plain data. The property names match both the
// DynamoDB `CreateTable` input and the CloudFormation `AWS::DynamoDB::Table` properties, so a
// deployment template and a local verifier render the same definition.

export const PARTITION_KEY = "pk";
export const SORT_KEY = "sk";

export const INDEX_NAMES = ["gsi1", "gsi2", "gsi3"] as const;
export type IndexName = (typeof INDEX_NAMES)[number];

export function indexPartitionKey(index: IndexName): string {
  return `${index}pk`;
}

export function indexSortKey(index: IndexName): string {
  return `${index}sk`;
}

interface AttributeDefinition {
  readonly AttributeName: string;
  readonly AttributeType: "S";
}

interface KeySchemaElement {
  readonly AttributeName: string;
  readonly KeyType: "HASH" | "RANGE";
}

interface GlobalSecondaryIndex {
  readonly IndexName: IndexName;
  readonly KeySchema: readonly KeySchemaElement[];
  readonly Projection: { readonly ProjectionType: "ALL" };
}

export interface StorageTableSchema {
  readonly AttributeDefinitions: readonly AttributeDefinition[];
  readonly KeySchema: readonly KeySchemaElement[];
  readonly GlobalSecondaryIndexes: readonly GlobalSecondaryIndex[];
  readonly BillingMode: "PAY_PER_REQUEST";
}

function keySchema(partition: string, sort: string): readonly KeySchemaElement[] {
  return [
    { AttributeName: partition, KeyType: "HASH" },
    { AttributeName: sort, KeyType: "RANGE" },
  ];
}

const keyAttributes = [
  PARTITION_KEY,
  SORT_KEY,
  ...INDEX_NAMES.flatMap((index) => [indexPartitionKey(index), indexSortKey(index)]),
];

export const STORAGE_TABLE: StorageTableSchema = {
  AttributeDefinitions: keyAttributes.map((name) => ({ AttributeName: name, AttributeType: "S" })),
  KeySchema: keySchema(PARTITION_KEY, SORT_KEY),
  GlobalSecondaryIndexes: INDEX_NAMES.map((index) => ({
    IndexName: index,
    KeySchema: keySchema(indexPartitionKey(index), indexSortKey(index)),
    Projection: { ProjectionType: "ALL" },
  })),
  BillingMode: "PAY_PER_REQUEST",
};

export function createTableInput(tableName: string): StorageTableSchema & { TableName: string } {
  return { TableName: tableName, ...STORAGE_TABLE };
}

// Prints the DynamoDB table the storage adapter expects as a CloudFormation resource, for a
// deployment template to include. `TABLE_NAME` sets the physical name; unset, CloudFormation
// generates one.
import { STORAGE_TABLE } from "@ai-moves/storage-dynamodb/tables";

import { readEnv } from "./env.ts";

const tableName = readEnv("TABLE_NAME");
const resource = {
  Type: "AWS::DynamoDB::Table",
  Properties: {
    ...(tableName === undefined ? {} : { TableName: tableName }),
    ...STORAGE_TABLE,
  },
};
console.log(JSON.stringify({ StorageTable: resource }, null, 2));

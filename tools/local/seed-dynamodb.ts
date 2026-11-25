// Writes the seed rows (see seed.ts) to a DynamoDB table through the storage adapter, so the
// same idempotency rules apply as at runtime: existing sources and destinations are kept, and
// the configuration is published only to a table that has none. Reads TABLE_NAME and the
// standard AWS variables; AWS_ENDPOINT_URL_DYNAMODB points it at a local emulator.
import { systemClock } from "@ai-moves/kernel/clock";
import { createIdGen } from "@ai-moves/kernel/id";
import { readAwsEnvironment } from "@ai-moves/runtime-aws/environment";
import { createAwsJsonClient, DYNAMODB_PROTOCOL } from "@ai-moves/runtime-aws/json-client";
import { createDynamoDbStorage } from "@ai-moves/storage-dynamodb/dynamodb";

import { readEnv } from "./env.ts";
import { buildSeed, seedOptionsFromEnv } from "./seed.ts";

const variables = ["TABLE_NAME", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID"];
const environment: Record<string, string | undefined> = {};
for (const name of [
  ...variables,
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_DYNAMODB",
]) {
  environment[name] = readEnv(name);
}
const tableName = environment["TABLE_NAME"];
if (tableName === undefined || tableName === "") throw new Error("TABLE_NAME is not set");

const aws = readAwsEnvironment(environment);
const storage = createDynamoDbStorage({
  api: createAwsJsonClient(DYNAMODB_PROTOCOL, {
    region: aws.region,
    credentials: aws.credentials,
    fetch: (request) => fetch(request),
    clock: systemClock,
    timeoutMs: 10_000,
    endpoint: aws.endpoints.dynamodb,
  }),
  tableName,
});

const now = systemClock.now();
const { config, sources, destination } = buildSeed(seedOptionsFromEnv(now));
const ids = createIdGen({ clock: systemClock });

const published = await storage.admin.publishConfig(config, 0, {
  id: ids.next(),
  actor: "seed",
  at: now,
});
console.log(published === null ? "config: kept the published version" : "config: published v1");
for (const source of sources) {
  const { created } = await storage.sources.upsert(source);
  console.log(`source ${source.key}: ${created ? "created" : "kept"}`);
}
const { created } = await storage.destinations.upsert(destination);
console.log(`destination ${destination.name}: ${created ? "created" : "kept"}`);

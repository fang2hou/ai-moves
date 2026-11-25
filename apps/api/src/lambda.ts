import { systemClock } from "@ai-moves/kernel/clock";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { readAwsEnvironment } from "@ai-moves/runtime-aws/environment";
import { createAwsJsonClient, DYNAMODB_PROTOCOL } from "@ai-moves/runtime-aws/json-client";
import { createDynamoDbStorage } from "@ai-moves/storage-dynamodb/dynamodb";
// `hono/aws-lambda` ships with the pinned hono 4 and is deprecated only in favour of a separate
// package for hono 5; it adds no dependency.
import { handle } from "hono/aws-lambda";

import { createApi } from "./app.ts";

const AWS_TIMEOUT_MS = 10_000;

export interface AwsApiSettings {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly tableName: string;
}

export function readAwsApiSettings(
  env: Readonly<Record<string, string | undefined>>,
): AwsApiSettings {
  const tableName = env["TABLE_NAME"];
  if (tableName === undefined || tableName === "") {
    throw new AppError("CONFIG_INVALID", { message: "TABLE_NAME is not set" });
  }
  return { environment: env, tableName };
}

// The read API only. Static desk assets are served by whatever fronts the function, so a path
// outside /api answers NOT_FOUND here.
export function createLambdaApi(settings: AwsApiSettings): ReturnType<typeof handle> {
  const aws = readAwsEnvironment(settings.environment);
  const { items, alerts, deliveries, config } = createDynamoDbStorage({
    api: createAwsJsonClient(DYNAMODB_PROTOCOL, {
      region: aws.region,
      credentials: aws.credentials,
      fetch: (request) => fetch(request),
      clock: systemClock,
      timeoutMs: AWS_TIMEOUT_MS,
      endpoint: aws.endpoints.dynamodb,
    }),
    tableName: settings.tableName,
  });
  return handle(createApi({ items, alerts, deliveries, config }));
}

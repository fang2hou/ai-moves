import type { QueueName } from "@ai-moves/contracts/messages";
import { QueueNameSchema } from "@ai-moves/contracts/messages";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { loadRuntimeEnv } from "@ai-moves/kernel/config";
import { systemClock } from "@ai-moves/kernel/clock";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { createIdGen } from "@ai-moves/kernel/id";
import { createConsoleTelemetry } from "@ai-moves/kernel/telemetry/console";
import { createS3BlobStore } from "@ai-moves/runtime-aws/blob-store";
import { readAwsEnvironment, type AwsEnvironment } from "@ai-moves/runtime-aws/environment";
import {
  createAwsJsonClient,
  DYNAMODB_PROTOCOL,
  SQS_PROTOCOL,
  SSM_PROTOCOL,
} from "@ai-moves/runtime-aws/json-client";
import {
  decodeScheduledEvent,
  decodeSqsJob,
  readSqsEvent,
  type SqsBatchResponse,
} from "@ai-moves/runtime-aws/lambda";
import { createSqsJobBus, type SqsQueueUrls } from "@ai-moves/runtime-aws/queue";
import { createSignedFetch } from "@ai-moves/runtime-aws/signed-fetch";
import { createBedrockClaudeClient } from "@ai-moves/llm/bedrock";
import { createSsmSecretProvider } from "@ai-moves/runtime-aws/secrets";
import { createDynamoDbStorage } from "@ai-moves/storage-dynamodb/dynamodb";

import { parseDeskOrigin, rejectWhitespace } from "../deployment-settings.ts";
import {
  codeOnlyError,
  createPipeline,
  openRouterFactory,
  type PipelineDeployment,
  type PipelineMessage,
} from "../pipeline.ts";
import { nodeEgress } from "./egress.ts";

const AWS_TIMEOUT_MS = 10_000;
const SECRET_CACHE_MS = 5 * 60_000;

// The names a Lambda deployment resolves before the pipeline runs. A deployment that cannot set
// environment variables builds this object itself and passes it to `createLambdaPipeline`.
export interface AwsPipelineSettings {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly tableName: string;
  readonly blobBucket: string;
  readonly queueUrls: SqsQueueUrls;
  readonly secretsPrefix: string;
  readonly deskOrigin: string;
}

type EnvRecord = Readonly<Record<string, string | undefined>>;

function required(env: EnvRecord, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new AppError("CONFIG_INVALID", { message: `${name} is not set`, context: { name } });
  }
  return value;
}

export function readAwsPipelineSettings(env: EnvRecord): AwsPipelineSettings {
  return {
    environment: env,
    tableName: required(env, "TABLE_NAME"),
    blobBucket: required(env, "BLOB_BUCKET"),
    queueUrls: {
      "q-poll": required(env, "QUEUE_URL_POLL"),
      "q-triage": required(env, "QUEUE_URL_TRIAGE"),
      "q-deep": required(env, "QUEUE_URL_DEEP"),
      "q-deliver": required(env, "QUEUE_URL_DELIVER"),
    },
    secretsPrefix: required(env, "SECRETS_PREFIX"),
    deskOrigin: required(env, "DESK_ORIGIN"),
  };
}

function queueName(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

function deployment(settings: AwsPipelineSettings, aws: AwsEnvironment): PipelineDeployment {
  const endpoint = (service: keyof AwsEnvironment["endpoints"]) => ({
    region: aws.region,
    credentials: aws.credentials,
    fetch: (request: Request) => fetch(request),
    clock: systemClock,
    timeoutMs: AWS_TIMEOUT_MS,
    endpoint: aws.endpoints[service],
  });
  return {
    settings: loadRuntimeEnv({
      ENVIRONMENT: settings.environment["ENVIRONMENT"],
      LOG_LEVEL: settings.environment["LOG_LEVEL"],
    }),
    deskOrigin: parseDeskOrigin(settings.deskOrigin),
    storage: createDynamoDbStorage({
      api: createAwsJsonClient(DYNAMODB_PROTOCOL, endpoint("dynamodb")),
      tableName: settings.tableName,
    }),
    jobs: createSqsJobBus(createAwsJsonClient(SQS_PROTOCOL, endpoint("sqs")), settings.queueUrls),
    blobs: createS3BlobStore({ ...endpoint("s3"), bucket: settings.blobBucket }),
    providerSecrets: rejectWhitespace(
      createSsmSecretProvider(createAwsJsonClient(SSM_PROTOCOL, endpoint("ssm")), {
        prefix: settings.secretsPrefix,
        clock: systemClock,
        cacheMs: SECRET_CACHE_MS,
      }),
    ),
    ...nodeEgress(),
    llm: {
      openrouter: openRouterFactory,
      // Claude in Amazon Bedrock is signed with the execution role; it needs no provider secret.
      bedrock: ({ models, timeoutMs }) =>
        Promise.resolve(
          createBedrockClaudeClient({
            fetch: createSignedFetch({
              service: "bedrock-mantle",
              region: aws.region,
              credentials: aws.credentials,
              clock: systemClock,
              fetch: (request) => fetch(request),
            }),
            region: aws.region,
            models,
            timeoutMs,
            endpoint: aws.endpoints["bedrock-mantle"],
          }),
        ),
    },
  };
}

export interface LambdaPipeline {
  tick(event: unknown): Promise<void>;
  queue(event: unknown): Promise<SqsBatchResponse>;
}

// Builds the handlers once per runtime instance; the deployment (clients, settings) is resolved
// lazily on the first event so a configuration error surfaces as a failed invocation.
export function createLambdaPipeline(resolveSettings: () => AwsPipelineSettings): LambdaPipeline {
  const pipeline = createPipeline({
    clock: systemClock,
    ids: createIdGen({ clock: systemClock }),
    telemetry: createConsoleTelemetry(),
  });
  let cached:
    | { readonly deployment: PipelineDeployment; readonly queues: Map<string, QueueName> }
    | undefined;
  function resolved() {
    if (cached === undefined) {
      const settings = resolveSettings();
      const queues = new Map<string, QueueName>();
      for (const [name, url] of Object.entries(settings.queueUrls)) {
        queues.set(queueName(url), parseBoundary(QueueNameSchema, name, "CONFIG_INVALID"));
      }
      cached = {
        deployment: deployment(settings, readAwsEnvironment(settings.environment)),
        queues,
      };
    }
    return cached;
  }
  return {
    async tick(event) {
      try {
        await pipeline.tick(decodeScheduledEvent(event, "schedule"), resolved().deployment);
      } catch (cause) {
        throw codeOnlyError(cause);
      }
    },
    // Reports the messages to redeliver instead of failing the batch, so one bad job does not
    // hold back the others. A message for an unknown queue is redelivered until it dead-letters.
    async queue(event) {
      const failures: { itemIdentifier: string }[] = [];
      try {
        const { deployment: current, queues } = resolved();
        const byQueue = new Map<QueueName, PipelineMessage[]>();
        for (const record of readSqsEvent(event)) {
          const arn = record.eventSourceARN;
          const queue = queues.get(arn.slice(arn.lastIndexOf(":") + 1));
          if (queue === undefined) {
            failures.push({ itemIdentifier: record.messageId });
            continue;
          }
          const message: PipelineMessage = {
            body: record.body,
            timestamp: record.sentAt === undefined ? undefined : new Date(record.sentAt),
            attempts: record.attempts,
            ack: () => undefined,
            retry: () => failures.push({ itemIdentifier: record.messageId }),
          };
          byQueue.set(queue, [...(byQueue.get(queue) ?? []), message]);
        }
        for (const [queue, messages] of byQueue) {
          await pipeline.consume(queue, messages, current, (name, message) =>
            decodeSqsJob(message.body, name),
          );
        }
      } catch (cause) {
        throw codeOnlyError(cause);
      }
      return { batchItemFailures: failures };
    },
  };
}

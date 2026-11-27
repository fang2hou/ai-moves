import type { QueueName } from "@ai-moves/contracts/messages";
import { QueueNameSchema } from "@ai-moves/contracts/messages";
import type { Submitter } from "@ai-moves/contracts/scoring";
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
import { createBedrockClaudeClient, type BedrockTransport } from "@ai-moves/llm/bedrock";
import { createSsmSecretProvider } from "@ai-moves/runtime-aws/secrets";
import { createDynamoDbStorage } from "@ai-moves/storage-dynamodb/dynamodb";

import { parseDeskOrigin, rejectWhitespace } from "../deployment-settings.ts";
import { createMcpHandler, isRecord } from "../mcp.ts";
import {
  codeOnlyError,
  createPipeline,
  hyperFactory,
  openRouterFactory,
  type LlmFactory,
  type NotifierFactory,
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
  // Replaces the webhook notifiers, for example with a deployment's own Slack integration.
  readonly notifiers?: NotifierFactory | undefined;
  // Names the submitter behind an MCP request from headers the deployment has verified (for
  // example headers an authenticating proxy sets), or null when there is none. Without it the MCP
  // endpoint answers every request with 401.
  readonly identifySubmitter?: ((headers: Headers) => Submitter | null) | undefined;
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
    notifiers: settings.notifiers,
    llm: {
      openrouter: openRouterFactory,
      hyper: hyperFactory,
      // Claude on Bedrock is signed with the execution role; it needs no provider secret.
      bedrock: bedrockFactory(aws, "messages"),
      "bedrock-runtime": bedrockFactory(aws, "invoke"),
    },
  };
}

function bedrockFactory(aws: AwsEnvironment, transport: BedrockTransport): LlmFactory {
  const messages = transport === "messages";
  return ({ models, timeoutMs }) =>
    Promise.resolve(
      createBedrockClaudeClient({
        transport,
        fetch: createSignedFetch({
          service: messages ? "bedrock-mantle" : "bedrock",
          region: aws.region,
          credentials: aws.credentials,
          clock: systemClock,
          fetch: (request) => fetch(request),
        }),
        region: aws.region,
        models,
        timeoutMs,
        endpoint: aws.endpoints[messages ? "bedrock-mantle" : "bedrock-runtime"],
      }),
    );
}

// The reply to a Lambda Function URL or API Gateway HTTP API (payload format 2.0) request.
export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface LambdaPipeline {
  tick(event: unknown): Promise<void>;
  queue(event: unknown): Promise<SqsBatchResponse>;
  mcp(event: unknown): Promise<HttpResponse>;
}

interface HttpEvent {
  readonly rawPath: string;
  readonly rawQueryString: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly method: string;
  readonly domainName: string | undefined;
  readonly body: string | undefined;
  readonly isBase64Encoded: boolean;
}

function readHttpEvent(input: unknown): HttpEvent | null {
  if (!isRecord(input)) return null;
  const { version, rawPath, rawQueryString, headers, requestContext, body, isBase64Encoded } =
    input;
  const http = isRecord(requestContext) ? requestContext : {};
  const request = isRecord(http["http"]) ? http["http"] : {};
  const method = request["method"];
  if (version !== "2.0" || typeof rawPath !== "string" || typeof method !== "string") {
    return null;
  }
  if (!isRecord(headers)) return null;
  const textHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") textHeaders[name] = value;
  }
  return {
    rawPath,
    rawQueryString: typeof rawQueryString === "string" ? rawQueryString : "",
    headers: textHeaders,
    method,
    domainName: typeof http["domainName"] === "string" ? http["domainName"] : undefined,
    body: typeof body === "string" ? body : undefined,
    isBase64Encoded: isBase64Encoded === true,
  };
}

function toFetchRequest(event: HttpEvent): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers)) {
    if (value !== undefined) headers.set(name, value);
  }
  const host = headers.get("host") ?? event.domainName ?? "localhost";
  const query = event.rawQueryString === "" ? "" : `?${event.rawQueryString}`;
  const hasBody = event.method !== "GET" && event.method !== "HEAD" && event.body !== undefined;
  let body: string | Uint8Array<ArrayBuffer> | null = null;
  if (hasBody && event.body !== undefined) {
    body = event.isBase64Encoded
      ? Uint8Array.from(atob(event.body), (char) => char.charCodeAt(0))
      : event.body;
  }
  return new Request(`https://${host}${event.rawPath}${query}`, {
    method: event.method,
    headers,
    body,
  });
}

async function toHttpResponse(response: Response): Promise<HttpResponse> {
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

// Builds the handlers once per runtime instance; the deployment (clients, settings) is resolved
// lazily on the first event so a configuration error surfaces as a failed invocation.
export function createLambdaPipeline(resolveSettings: () => AwsPipelineSettings): LambdaPipeline {
  const runtime = {
    clock: systemClock,
    ids: createIdGen({ clock: systemClock }),
    telemetry: createConsoleTelemetry(),
  };
  const pipeline = createPipeline(runtime);
  let cached:
    | {
        readonly deployment: PipelineDeployment;
        readonly queues: Map<string, QueueName>;
        readonly mcp: (request: Request) => Promise<Response>;
      }
    | undefined;
  function resolved() {
    if (cached === undefined) {
      const settings = resolveSettings();
      const queues = new Map<string, QueueName>();
      for (const [name, url] of Object.entries(settings.queueUrls)) {
        queues.set(queueName(url), parseBoundary(QueueNameSchema, name, "CONFIG_INVALID"));
      }
      const built = deployment(settings, readAwsEnvironment(settings.environment));
      const identify = settings.identifySubmitter;
      cached = {
        deployment: built,
        queues,
        mcp: createMcpHandler({
          pipeline,
          deployment: built,
          runtime,
          identify: (request) => identify?.(request.headers) ?? null,
        }),
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
    // Serves the MCP endpoint for a Function URL or API Gateway HTTP API (payload format 2.0).
    async mcp(event) {
      const http = readHttpEvent(event);
      if (http === null) {
        return {
          statusCode: 400,
          headers: { "content-type": "text/plain" },
          body: "Unsupported event",
        };
      }
      try {
        return await toHttpResponse(await resolved().mcp(toFetchRequest(http)));
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

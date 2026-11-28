import { MAX_CONSUMER_BATCH_SIZE, QueueNameSchema } from "@ai-news-tracker/contracts/messages";
import { parseBoundary } from "@ai-news-tracker/kernel/boundary";
import { systemClock } from "@ai-news-tracker/kernel/clock";
import { AppError } from "@ai-news-tracker/kernel/errors/app-error";
import { createIdGen } from "@ai-news-tracker/kernel/id";
import { createConsoleTelemetry } from "@ai-news-tracker/kernel/telemetry/console";
import { createCloudflareBlobStore } from "@ai-news-tracker/runtime-cloudflare/blob-store";
import {
  decodeQueueBatch,
  decodeScheduledEvent,
  type WorkerScheduledController,
} from "@ai-news-tracker/runtime-cloudflare/messages";
import { createCloudflareJobBus } from "@ai-news-tracker/runtime-cloudflare/queue";
import { createD1Storage } from "@ai-news-tracker/storage-d1/d1";
import type { ExportedHandler, Request as WorkerRequest } from "@cloudflare/workers-types";

import { readBindings, readMcpAccess, type PipelineBindings } from "./bindings.ts";
import { platformEgress } from "./egress.ts";
import { createMcpHandler } from "./mcp.ts";
import {
  codeOnlyError,
  createPipeline,
  hyperFactory,
  type JobDecoder,
  openRouterFactory,
  type PipelineDeployment,
  type PipelineMessage,
  type RuntimePorts,
} from "./pipeline.ts";

interface QueueBatch {
  readonly queue: unknown;
  readonly messages: readonly PipelineMessage[];
}

export interface PipelineWorker {
  scheduled(controller: WorkerScheduledController, env: PipelineBindings): Promise<void>;
  queue(batch: QueueBatch, env: PipelineBindings): Promise<void>;
  // The MCP endpoint, answered with 404 while MCP_TOKEN is unset.
  mcp(request: Request, env: PipelineBindings): Promise<Response>;
}

// A deployment suffixes its queues so that two environments can run side by side
// (`q-deep-dev`). The job contract names the queue without that suffix.
function logicalQueue(name: unknown): unknown {
  return typeof name === "string" ? name.replace(/-(?:dev|staging)$/u, "") : name;
}

const decodeWorkerMessage: JobDecoder = (queue, message) => {
  const [job] = decodeQueueBatch({ queue, messages: [message] });
  if (job === undefined) throw new AppError("MESSAGE_INVALID");
  return job;
};

function deployment(env: PipelineBindings): PipelineDeployment {
  const { settings, queues, deskOrigin, providerSecrets } = readBindings(env);
  return {
    settings,
    deskOrigin,
    storage: createD1Storage(env.DB),
    jobs: createCloudflareJobBus(queues),
    blobs: createCloudflareBlobStore(env.BLOBS),
    providerSecrets,
    providerHttp: env.PROVIDER_HTTP,
    pinnedWeb: env.PINNED_WEB,
    llm: { openrouter: openRouterFactory, hyper: hyperFactory },
  };
}

export function createPipelineWorker(runtime: RuntimePorts): PipelineWorker {
  const pipeline = createPipeline(runtime);
  const worker: PipelineWorker = {
    async scheduled(controller, env) {
      const event = decodeScheduledEvent(controller);
      await pipeline.tick(event, deployment(env));
    },
    async queue(batch, env) {
      const queue = parseBoundary(QueueNameSchema, logicalQueue(batch?.queue), "MESSAGE_INVALID");
      validateBatch(batch);
      await pipeline.consume(queue, batch.messages, deployment(env), decodeWorkerMessage);
    },
    async mcp(request, env) {
      const access = readMcpAccess(env);
      if (access === null) return new Response("Not found", { status: 404 });
      const { token, submitter } = access;
      return createMcpHandler({
        pipeline,
        deployment: deployment(env),
        runtime,
        identify(candidate) {
          const header = candidate.headers.get("authorization") ?? "";
          const offered = /^Bearer (\S+)$/iu.exec(header)?.[1];
          return offered !== undefined &&
            offered.length === token.length &&
            timingSafeEqual(offered, token)
            ? submitter
            : null;
        },
      })(request);
    },
  };
  return {
    scheduled: (controller, env) => worker.scheduled(controller, env).catch(rejectInvocation),
    queue: (batch, env) => worker.queue(batch, env).catch(rejectInvocation),
    mcp: (request, env) => worker.mcp(request, env).catch(rejectInvocation),
  };
}

function rejectInvocation(cause: unknown): never {
  // The runtime can log an unhandled rejection independently of our telemetry.
  throw codeOnlyError(cause);
}

function validateBatch(batch: QueueBatch): void {
  if (
    !Array.isArray(batch.messages) ||
    batch.messages.length > MAX_CONSUMER_BATCH_SIZE ||
    batch.messages.some(
      (message: PipelineMessage) =>
        typeof message?.ack !== "function" || typeof message.retry !== "function",
    )
  ) {
    throw new AppError("MESSAGE_INVALID", { message: "Invalid Worker queue batch" });
  }
}

const pipeline = createPipelineWorker({
  clock: systemClock,
  ids: createIdGen({ clock: systemClock }),
  telemetry: createConsoleTelemetry(),
});

// A deployment has no binding for outbound HTTP, so the platform's own fetch is
// added to the environment the handler reads. A runner that supplies its own keeps it.
type DeployedBindings = Omit<PipelineBindings, "PROVIDER_HTTP" | "PINNED_WEB"> &
  Partial<Pick<PipelineBindings, "PROVIDER_HTTP" | "PINNED_WEB">>;

function bound(env: DeployedBindings): PipelineBindings {
  return { ...platformEgress(), ...env };
}

// A tick on demand, for checking a deployment without waiting for the cron. It runs
// exactly what the schedule runs, and only for a caller who knows TRIGGER_TOKEN; with
// no token configured there is no way in at all.
async function trigger(request: WorkerRequest, env: DeployedBindings): Promise<Response> {
  const token = env.TRIGGER_TOKEN;
  const offered = request.headers.get("x-trigger-token");
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== "/trigger" ||
    typeof token !== "string" ||
    token.length < 16 ||
    offered === null ||
    offered.length !== token.length ||
    !timingSafeEqual(offered, token)
  ) {
    return new Response("Not found", { status: 404 });
  }
  const at = systemClock.now();
  await pipeline.scheduled({ scheduledTime: at, cron: "manual" }, bound(env));
  return Response.json({ ran: "scheduled", at });
}

// Routes the two HTTP entries. The platform's request type is not the standard one the MCP
// handler takes, so the request is rebuilt from its parts.
async function route(request: WorkerRequest, env: DeployedBindings): Promise<Response> {
  if (new URL(request.url).pathname !== "/mcp") return trigger(request, env);
  return pipeline.mcp(
    new Request(request.url, {
      method: request.method,
      headers: Array.from(request.headers.entries()),
      body: request.method === "POST" ? await request.text() : null,
    }),
    bound(env),
  );
}

function timingSafeEqual(left: string, right: string): boolean {
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= (left.codePointAt(index) ?? 0) ^ (right.codePointAt(index) ?? 0);
  }
  return difference === 0;
}

// The two handlers the platform drives on its own are checked against the platform's
// shape; the manual trigger is this module's own entry and carries its own types.
const handlers = {
  scheduled: (controller: WorkerScheduledController, env: DeployedBindings) =>
    pipeline.scheduled(controller, bound(env)),
  queue: (batch: QueueBatch, env: DeployedBindings) => pipeline.queue(batch, bound(env)),
} satisfies ExportedHandler<DeployedBindings>;

// oxlint-disable-next-line import/no-default-export -- Workers require the module handler as the default export.
export default { ...handlers, fetch: route };

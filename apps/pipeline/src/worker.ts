import { processDeep, type DeepDependencies } from "@ai-moves/analysis/deep";
import type { FinalizeAlert } from "@ai-moves/analysis/finalization";
import { processTriage } from "@ai-moves/analysis/triage";
import { cloudflarePipelineConfigIssue, type AppConfig } from "@ai-moves/contracts/config";
import type { Alert } from "@ai-moves/contracts/entities";
import { MAX_CONSUMER_BATCH_SIZE, QueueNameSchema, type Job } from "@ai-moves/contracts/messages";
import type {
  Clock,
  IdGen,
  JobBus,
  SecretProvider,
  Telemetry,
} from "@ai-moves/contracts/ports/runtime";
import type { WebFetcher } from "@ai-moves/contracts/ports/sources";
import type { BlobStore } from "@ai-moves/contracts/ports/storage";
import { pollSource } from "@ai-moves/ingestion/poll";
import { sweepStaleWork } from "@ai-moves/ingestion/sweep";
import { dispatchDueSources } from "@ai-moves/ingestion/tick";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { systemClock } from "@ai-moves/kernel/clock";
import { loadAppConfig } from "@ai-moves/kernel/config";
import { AppError, toAppError } from "@ai-moves/kernel/errors/app-error";
import { createIdGen } from "@ai-moves/kernel/id";
import { createLogger, type LogContext, type Logger } from "@ai-moves/kernel/logger";
import { redactText } from "@ai-moves/kernel/redact";
import { createConsoleTelemetry } from "@ai-moves/kernel/telemetry/console";
import { createOpenRouterClient } from "@ai-moves/llm/openrouter";
import { createCloudflareBlobStore } from "@ai-moves/runtime-cloudflare/blob-store";
import {
  decodeQueueBatch,
  decodeScheduledEvent,
  type WorkerScheduledController,
} from "@ai-moves/runtime-cloudflare/messages";
import { createCloudflareJobBus } from "@ai-moves/runtime-cloudflare/queue";
import { createGitHubClient } from "@ai-moves/sources/github";
import { createHnClient } from "@ai-moves/sources/hn";
import { createWebFetcher } from "@ai-moves/sources/web";
import { createD1Storage, type D1StorageRepositories } from "@ai-moves/storage/d1";
import type { ExportedHandler } from "@cloudflare/workers-types";

import { readBindings, type PipelineBindings } from "./bindings.ts";
import {
  bestEffortTelemetry,
  observeAnalyses,
  observeBudgets,
  observeItems,
} from "./observability.ts";

const TICK_LIMIT = 100;
const POLL_LEASE_MS = 4 * 60_000;
const MODEL_SECRET = "OPENROUTER_API_KEY";
const GITHUB_SECRET = "GITHUB_TOKEN";
const ROLLOUT_FEED_ONLY = "rollout_feed_only";

interface QueueMessage {
  readonly body: unknown;
  readonly timestamp?: Date;
  readonly attempts?: number;
  ack(): void;
  retry(): void;
}

interface QueueBatch {
  readonly queue: unknown;
  readonly messages: readonly QueueMessage[];
}

interface RuntimePorts {
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly telemetry: Telemetry;
}

interface Work extends Omit<D1StorageRepositories, "config">, RuntimePorts {
  readonly config: AppConfig;
  readonly configVersion: number;
  readonly logger: Logger;
  readonly providerSecrets: SecretProvider;
  readonly deskOrigin: string;
  readonly jobs: JobBus;
  readonly blobs: BlobStore;
  readonly providerHttp: PipelineBindings["PROVIDER_HTTP"];
  readonly web: WebFetcher;
}

export interface PipelineWorker {
  scheduled(controller: WorkerScheduledController, env: PipelineBindings): Promise<void>;
  queue(batch: QueueBatch, env: PipelineBindings): Promise<void>;
}

export function createPipelineWorker(runtime: RuntimePorts): PipelineWorker {
  const ports = { ...runtime, telemetry: bestEffortTelemetry(runtime.telemetry) };
  const worker: PipelineWorker = {
    async scheduled(controller, env) {
      const event = decodeScheduledEvent(controller);
      const work = await loadWork(env, ports);
      const [dispatch, sweep] = await Promise.allSettled([
        dispatchDueSources(work, event, TICK_LIMIT),
        sweepStaleWork(work, { config: work.config, limit: TICK_LIMIT }),
      ]);
      if (dispatch.status === "rejected") {
        work.logger.error("pipeline.dispatch_failed", {
          stage: "tick",
          err: codeOnlyError(dispatch.reason),
        });
      }
      if (sweep.status === "rejected") {
        work.logger.error("pipeline.sweep_failed", {
          stage: "sweep",
          err: codeOnlyError(sweep.reason),
        });
        if (dispatch.status === "fulfilled") throw toAppError(sweep.reason);
      }
      if (dispatch.status === "rejected") throw toAppError(dispatch.reason);
    },
    async queue(batch, env) {
      const queue = parseBoundary(QueueNameSchema, batch?.queue, "MESSAGE_INVALID");
      validateBatch(batch);
      const work = await loadWork(env, ports);
      for (const [index, message] of batch.messages.entries()) {
        const startedAt = work.clock.now();
        const attempt = message.attempts;
        const timestamp = message.timestamp;
        const enqueuedAt = timestamp instanceof Date ? timestamp.getTime() : NaN;
        if (Number.isFinite(enqueuedAt) && enqueuedAt >= 0 && enqueuedAt <= startedAt) {
          work.telemetry.count("pipeline.queue.age_ms", startedAt - enqueuedAt, { queue });
        }
        let job: Job | undefined;
        let context: LogContext | undefined;
        try {
          [job] = decodeQueueBatch({ queue, messages: [message] });
          if (job === undefined) throw new AppError("MESSAGE_INVALID");
          context = jobContext(job);
          await runJob(work, job, context);
        } catch (cause) {
          const duration = Math.max(0, work.clock.now() - startedAt);
          work.logger.error("pipeline.message_failed", {
            ...context,
            err: codeOnlyError(cause),
            duration_ms: duration,
            attrs: { queue, index, attempt: validAttempt(attempt) },
          });
          message.retry();
          work.telemetry.count("pipeline.queue.disposition", 1, { queue, outcome: "retry" });
          if (job !== undefined) {
            work.telemetry.count("pipeline.job.duration_ms", duration, {
              stage: job.type,
              outcome: "retry",
            });
          }
          continue;
        }
        const duration = Math.max(0, work.clock.now() - startedAt);
        message.ack();
        work.telemetry.count("pipeline.queue.disposition", 1, { queue, outcome: "ack" });
        work.telemetry.count("pipeline.job.duration_ms", duration, {
          stage: job.type,
          outcome: "ack",
        });
        work.logger.info("pipeline.message_acknowledged", {
          ...context,
          duration_ms: duration,
          attrs: { queue, attempt: validAttempt(attempt) },
        });
      }
    },
  };
  return {
    scheduled: (controller, env) => worker.scheduled(controller, env).catch(rejectInvocation),
    queue: (batch, env) => worker.queue(batch, env).catch(rejectInvocation),
  };
}

function codeOnlyError(cause: unknown): AppError {
  return new AppError(toAppError(cause).code);
}

function rejectInvocation(cause: unknown): never {
  // The runtime can log an unhandled rejection independently of our telemetry.
  throw codeOnlyError(cause);
}

function validAttempt(attempt: number | undefined): number | undefined {
  return attempt !== undefined && Number.isSafeInteger(attempt) && attempt > 0
    ? attempt
    : undefined;
}

function jobContext(job: Job): LogContext {
  const trace = job.trace_id;
  const source = job.type === "poll" ? job.source_id : undefined;
  const item = job.type === "triage" || job.type === "deep" ? job.item_id : undefined;
  return {
    stage: job.type,
    ...(redactText(trace) === trace ? { trace_id: trace } : {}),
    ...(source !== undefined && redactText(source) === source ? { source_id: source } : {}),
    ...(item !== undefined && redactText(item) === item ? { item_id: item } : {}),
  };
}

function validateBatch(batch: QueueBatch): void {
  if (
    !Array.isArray(batch.messages) ||
    batch.messages.length > MAX_CONSUMER_BATCH_SIZE ||
    batch.messages.some(
      (message: QueueMessage) =>
        typeof message?.ack !== "function" || typeof message.retry !== "function",
    )
  ) {
    throw new AppError("MESSAGE_INVALID", { message: "Invalid Worker queue batch" });
  }
}

async function loadWork(env: PipelineBindings, runtime: RuntimePorts): Promise<Work> {
  const { settings, queues, deskOrigin, providerSecrets } = readBindings(env);
  const storage = createD1Storage(env.DB);
  const persisted = await storage.config.getCurrent();
  if (persisted === null) {
    throw new AppError("CONFIG_INVALID", { message: "No published pipeline configuration" });
  }
  const config = loadAppConfig(persisted.config);
  const issue = cloudflarePipelineConfigIssue(config);
  if (issue !== undefined) {
    throw new AppError("CONFIG_INVALID", { message: issue });
  }
  const web = createWebFetcher({
    config: config.web_fetch,
    timeoutMs: config.timeouts.web_fetch_ms,
    resolve: (hostname) => env.PINNED_WEB.resolve(hostname),
    fetchPinned: ({ request, address }) => env.PINNED_WEB.fetchPinned(request, address),
  });
  const logger = createLogger({
    telemetry: runtime.telemetry,
    clock: runtime.clock,
    component: "pipeline",
    level: settings.LOG_LEVEL,
  });
  return {
    ...storage,
    ...runtime,
    config,
    configVersion: persisted.version,
    logger,
    providerSecrets,
    deskOrigin,
    jobs: createCloudflareJobBus(queues),
    blobs: createCloudflareBlobStore(env.BLOBS),
    providerHttp: env.PROVIDER_HTTP,
    web,
  };
}

async function runJob(work: Work, job: Job, context: LogContext): Promise<void> {
  const { config, providerHttp } = work;
  const transport = (request: Request): Promise<Response> => providerHttp.fetch(request);
  const logger = work.logger.child(context);
  switch (job.type) {
    case "poll": {
      const result = await pollSource(
        {
          ...work,
          hn: createHnClient({ fetch: transport, timeoutMs: config.timeouts.hn_ms }),
          github: createGitHubClient({
            fetch: transport,
            token: await work.providerSecrets.get(GITHUB_SECRET),
            timeoutMs: config.timeouts.github_ms,
          }),
        },
        job,
        { config, leaseMs: POLL_LEASE_MS },
      );
      work.telemetry.count("pipeline.poll.result", 1, { outcome: result.status });
      if (result.status === "backoff") {
        logger.warn("pipeline.poll_backoff", { attrs: { code: result.error.code } });
      }
      return;
    }
    case "triage":
    case "deep": {
      const llm = await createOpenRouterClient({
        fetch: transport,
        secrets: work.providerSecrets,
        secretRef: MODEL_SECRET,
        models: config.models,
        timeoutMs: config.timeouts.llm_ms,
      });
      const observed = {
        ...work,
        llm,
        items: observeItems(work.items, logger, job.type),
        analyses: observeAnalyses(work.analyses, logger, job.type),
        budgets: observeBudgets(work.budgets, logger, work.telemetry, job.type),
      };
      if (job.type === "triage") return processTriage(observed, job);
      const deps: DeepDependencies = {
        ...observed,
        hn: createHnClient({ fetch: transport, timeoutMs: config.timeouts.hn_ms }),
        detailUrl: (itemId) => `${work.deskOrigin}/items/${encodeURIComponent(itemId)}`,
        finalize: makeFinalizer(work),
      };
      return processDeep(deps, job);
    }
    case "deliver": {
      const id = job.delivery_id;
      const row = await work.deliveries.get(id);
      if (row === null || (row.state !== "pending" && row.state !== "failed_retryable")) return;
      const suppressed = await work.deliveries.transition({
        id,
        from: row.state,
        to: "suppressed",
        at: work.clock.now(),
        expected: row,
        patch: { suppressed_reason: ROLLOUT_FEED_ONLY, next_attempt_at: null },
      });
      if (suppressed) {
        work.telemetry.count("pipeline.delivery.transition", 1, { state: "suppressed" });
        logger.info("pipeline.delivery_transition", {
          attrs: {
            from: row.state,
            state: "suppressed",
            attempt: row.attempts,
            reason: ROLLOUT_FEED_ONLY,
          },
        });
      }
      return;
    }
  }
}

function makeFinalizer(work: Work): FinalizeAlert {
  return async ({ alert, documents }) => {
    const feedAlert: Alert =
      alert.decision === "send"
        ? {
            ...alert,
            decision: "feed_only",
            decision_reason_json: {
              ...alert.decision_reason_json,
              blocked_by: [...alert.decision_reason_json.blocked_by, ROLLOUT_FEED_ONLY],
            },
          }
        : alert;
    const stored = await work.alerts.insertWithDeliveries(feedAlert, [], documents);
    return stored.value;
  };
}

// oxlint-disable-next-line import/no-default-export -- Workers require the module handler as the default export.
export default createPipelineWorker({
  clock: systemClock,
  ids: createIdGen({ clock: systemClock }),
  telemetry: createConsoleTelemetry(),
}) satisfies ExportedHandler<PipelineBindings>;

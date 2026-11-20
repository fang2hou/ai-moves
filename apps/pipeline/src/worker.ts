import { processDeep, type DeepDependencies } from "@ai-moves/analysis/deep";
import type { FinalizeAlert } from "@ai-moves/analysis/finalization";
import { processTriage } from "@ai-moves/analysis/triage";
import { cloudflarePipelineConfigIssue, type AppConfig } from "@ai-moves/contracts/config";
import { MAX_CONSUMER_BATCH_SIZE, QueueNameSchema, type Job } from "@ai-moves/contracts/messages";
import type { Notifier } from "@ai-moves/contracts/ports/notifier";
import type {
  Clock,
  IdGen,
  JobBus,
  SecretProvider,
  Telemetry,
} from "@ai-moves/contracts/ports/runtime";
import type { WebFetcher } from "@ai-moves/contracts/ports/sources";
import type { BlobStore } from "@ai-moves/contracts/ports/storage";
import type { DestinationChannel } from "@ai-moves/contracts/states";
import { executeDelivery } from "@ai-moves/delivery/execute";
import { finalizeAlert, planDeliveries } from "@ai-moves/delivery/finalize";
import { createWebhookNotifier } from "@ai-moves/delivery/notifiers/webhook";
import { pollSource } from "@ai-moves/ingestion/poll";
import { sweepStaleWork } from "@ai-moves/ingestion/sweep";
import { dispatchDueSources } from "@ai-moves/ingestion/tick";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { systemClock } from "@ai-moves/kernel/clock";
import { loadAppConfig } from "@ai-moves/kernel/config";
import { AppError, toAppError } from "@ai-moves/kernel/errors/app-error";
import { createIdGen } from "@ai-moves/kernel/id";
import { createLogger, type Logger } from "@ai-moves/kernel/logger";
import { createConsoleTelemetry } from "@ai-moves/kernel/telemetry/console";
import { withTimeout } from "@ai-moves/kernel/timeout";
import { createOpenRouterClient } from "@ai-moves/llm/openrouter";
import { createCloudflareBlobStore } from "@ai-moves/runtime-cloudflare/blob-store";
import {
  decodeQueueBatch,
  decodeScheduledEvent,
  type WorkerScheduledController,
} from "@ai-moves/runtime-cloudflare/messages";
import { createCloudflareJobBus } from "@ai-moves/runtime-cloudflare/queue";
import { createCloudflareSecretProvider } from "@ai-moves/runtime-cloudflare/secrets";
import { createGitHubClient } from "@ai-moves/sources/github";
import { createHnClient } from "@ai-moves/sources/hn";
import { createWebFetcher } from "@ai-moves/sources/web";
import { createD1Storage, type D1StorageRepositories } from "@ai-moves/storage/d1";
import type { ExportedHandler } from "@cloudflare/workers-types";

import { readBindings, type PipelineBindings } from "./bindings.ts";

const TICK_LIMIT = 100;
const POLL_LEASE_MS = 4 * 60_000;
const HOUR_MS = 3_600_000;
const MODEL_SECRET = "OPENROUTER_API_KEY";
const GITHUB_SECRET = "GITHUB_TOKEN";

interface QueueMessage {
  readonly body: unknown;
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
  readonly secrets: SecretProvider;
  readonly githubToken: string;
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
  return {
    async scheduled(controller, env) {
      const event = decodeScheduledEvent(controller);
      const work = await loadWork(env, runtime);
      const [dispatch, sweep] = await Promise.allSettled([
        dispatchDueSources(work, event, TICK_LIMIT),
        sweepStaleWork(work, { config: work.config, limit: TICK_LIMIT }),
      ]);
      if (dispatch.status === "rejected") {
        work.logger.error("pipeline.dispatch_failed", { err: dispatch.reason });
      }
      if (sweep.status === "rejected") {
        work.logger.error("pipeline.sweep_failed", { err: sweep.reason });
        if (dispatch.status === "fulfilled") throw toAppError(sweep.reason);
      }
      if (dispatch.status === "rejected") throw toAppError(dispatch.reason);
    },
    async queue(batch, env) {
      const queue = parseBoundary(QueueNameSchema, batch?.queue, "MESSAGE_INVALID");
      validateBatch(batch);
      const work = await loadWork(env, runtime);
      for (const [index, message] of batch.messages.entries()) {
        let job: Job | undefined;
        try {
          [job] = decodeQueueBatch({ queue, messages: [message] });
          if (job === undefined) throw new AppError("MESSAGE_INVALID");
          await runJob(work, job);
        } catch (cause) {
          work.logger.error("pipeline.message_failed", {
            err: cause,
            ...(job === undefined ? {} : { trace_id: job.trace_id }),
            attrs: { queue, index },
          });
          message.retry();
          continue;
        }
        message.ack();
      }
    },
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
  const { settings, queues, deskOrigin } = readBindings(env);
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
  const secrets = createCloudflareSecretProvider(env);
  const [githubToken, modelToken] = await Promise.all([
    secrets.get(GITHUB_SECRET),
    secrets.get(MODEL_SECRET),
  ]);
  if (/\s/u.test(githubToken) || /\s/u.test(modelToken)) {
    throw new AppError("CONFIG_INVALID", { message: "Provider secret contains whitespace" });
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
    secrets,
    githubToken,
    deskOrigin,
    jobs: createCloudflareJobBus(queues),
    blobs: createCloudflareBlobStore(env.BLOBS),
    providerHttp: env.PROVIDER_HTTP,
    web,
  };
}

async function runJob(work: Work, job: Job): Promise<void> {
  const { config, providerHttp } = work;
  const transport = (request: Request): Promise<Response> => providerHttp.fetch(request);
  switch (job.type) {
    case "poll": {
      const result = await pollSource(
        {
          ...work,
          hn: createHnClient({ fetch: transport, timeoutMs: config.timeouts.hn_ms }),
          github: createGitHubClient({
            fetch: transport,
            token: work.githubToken,
            timeoutMs: config.timeouts.github_ms,
          }),
        },
        job,
        { config, leaseMs: POLL_LEASE_MS },
      );
      if (result.status === "backoff") {
        work.logger.warn("pipeline.poll_backoff", {
          trace_id: job.trace_id,
          source_id: job.source_id,
          attrs: { code: result.error.code },
        });
      }
      return;
    }
    case "triage":
    case "deep": {
      const llm = await createOpenRouterClient({
        fetch: transport,
        secrets: work.secrets,
        secretRef: MODEL_SECRET,
        models: config.models,
        timeoutMs: config.timeouts.llm_ms,
      });
      if (job.type === "triage") return processTriage({ ...work, llm }, job);
      const deps: DeepDependencies = {
        ...work,
        llm,
        hn: createHnClient({ fetch: transport, timeoutMs: config.timeouts.hn_ms }),
        detailUrl: (itemId) => `${work.deskOrigin}/items/${encodeURIComponent(itemId)}`,
        finalize: makeFinalizer(work),
      };
      return processDeep(deps, job);
    }
    case "deliver": {
      return executeDelivery(
        {
          ...work,
          notifiers: {
            slack: boundedNotifier("slack", work),
            discord: boundedNotifier("discord", work),
          },
        },
        job.delivery_id,
        config,
      );
    }
  }
}

function boundedNotifier(channel: DestinationChannel, work: Work): Notifier {
  return {
    channel,
    send: (destination, doc, idempotencyKey) =>
      withTimeout(
        (signal) =>
          createWebhookNotifier(
            channel,
            (request) => work.providerHttp.fetch(new Request(request, { signal })),
            work.secrets,
          ).send(destination, doc, idempotencyKey),
        { timeoutMs: work.config.timeouts.notifier_ms, code: "OUTCOME_UNKNOWN" },
      ),
  };
}

function makeFinalizer(work: Work): FinalizeAlert {
  return async ({ alert, documents, item, traceId, config }) => {
    const destinations =
      alert.decision === "send"
        ? (await work.destinations.list()).filter(({ purpose }) => purpose === "alerts")
        : [];
    const deliveries = planDeliveries({
      alert,
      documents,
      destinations,
      itemKind: item.kind,
      now: work.clock.now(),
      expiresAt: alert.created_at + config.delivery.expiry_hours[item.kind] * HOUR_MS,
      forceDryRun: config.delivery.force_dry_run,
      ids: work.ids,
    });
    return finalizeAlert(work, { alert, documents, deliveries, traceId });
  };
}

// oxlint-disable-next-line import/no-default-export -- Workers require the module handler as the default export.
export default createPipelineWorker({
  clock: systemClock,
  ids: createIdGen({ clock: systemClock }),
  telemetry: createConsoleTelemetry(),
}) satisfies ExportedHandler<PipelineBindings>;

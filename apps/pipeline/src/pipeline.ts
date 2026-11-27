import { processDeep, type DeepDependencies } from "@ai-moves/analysis/deep";
import type { FinalizeAlert } from "@ai-moves/analysis/finalization";
import { createHnRelevanceJudge } from "@ai-moves/analysis/relevance";
import { processTriage } from "@ai-moves/analysis/triage";
import { executionKey, itemSnapshotHash, readOutput } from "@ai-moves/analysis/work";
import { TriageAssessmentSchema } from "@ai-moves/contracts/analysis";
import {
  pipelineConfigIssue,
  stageModels,
  type AppConfig,
  type ModelConfig,
  type RuntimeEnv,
} from "@ai-moves/contracts/config";
import type { Alert, Item, LlmUsage } from "@ai-moves/contracts/entities";
import type { GenerateStructuredRequest, LlmClient } from "@ai-moves/contracts/ports/llm";
import type { Notifier } from "@ai-moves/contracts/ports/notifier";
import type { Job, QueueName, TickEvent } from "@ai-moves/contracts/messages";
import type {
  Clock,
  HttpFetch,
  IdGen,
  JobBus,
  SecretProvider,
  Telemetry,
} from "@ai-moves/contracts/ports/runtime";
import type { WebFetcher } from "@ai-moves/contracts/ports/sources";
import type {
  AnalysisRepo,
  BlobStore,
  StorageRepositories,
} from "@ai-moves/contracts/ports/storage";
import type { Submitter } from "@ai-moves/contracts/scoring";
import type { AnalysisStage, DestinationChannel } from "@ai-moves/contracts/states";
import type {
  SubmissionInput,
  SubmissionList,
  SubmissionResult,
  SubmissionSummary,
} from "@ai-moves/contracts/submission";
import { pollSource } from "@ai-moves/ingestion/poll";
import { refreshPublishedItems } from "@ai-moves/ingestion/refresh";
import { forceSubmission, listSubmissions, submitItem } from "@ai-moves/ingestion/submission";
import { sweepStaleWork } from "@ai-moves/ingestion/sweep";
import { dispatchDueSources } from "@ai-moves/ingestion/tick";
import { executeDelivery } from "@ai-moves/delivery/execute";
import { finalizeAlert, planDeliveries } from "@ai-moves/delivery/finalize";
import { createWebhookNotifier } from "@ai-moves/delivery/notifiers/webhook";
import { loadAppConfig } from "@ai-moves/kernel/config";
import { AppError, isAppError, toAppError } from "@ai-moves/kernel/errors/app-error";
import { createLogger, type LogContext, type Logger } from "@ai-moves/kernel/logger";
import { redactText } from "@ai-moves/kernel/redact";
import { createHyperClient } from "@ai-moves/llm/hyper";
import { createOpenRouterClient } from "@ai-moves/llm/openrouter";
import { createGitHubClient } from "@ai-moves/sources/github";
import { createHnClient } from "@ai-moves/sources/hn";
import { createWebFetcher } from "@ai-moves/sources/web";

import { bestEffortTelemetry, observeAnalyses, observeItems } from "./observability.ts";

const TICK_LIMIT = 100;
const POLL_LEASE_MS = 4 * 60_000;
const GITHUB_SECRET = "GITHUB_TOKEN";
const ROLLOUT_FEED_ONLY = "rollout_feed_only";

export interface LlmFactoryInput {
  readonly models: Readonly<Record<AnalysisStage, ModelConfig>>;
  readonly timeoutMs: number;
  readonly secrets: SecretProvider;
  readonly transport: HttpFetch;
}

export type LlmFactory = (input: LlmFactoryInput) => Promise<LlmClient>;

// The model providers a deployment can reach, by the `provider` name a route configures.
export type LlmProviders = Readonly<Record<string, LlmFactory>>;

export const openRouterFactory: LlmFactory = ({ models, timeoutMs, secrets, transport }) =>
  createOpenRouterClient({
    fetch: transport,
    secrets,
    secretRef: "OPENROUTER_API_KEY",
    models,
    timeoutMs,
  });

export const hyperFactory: LlmFactory = ({ models, timeoutMs, secrets, transport }) =>
  createHyperClient({
    fetch: transport,
    secrets,
    secretRef: "HYPER_API_KEY",
    models,
    timeoutMs,
  });

// Builds the notifier for each destination channel. Unless a deployment supplies its own, Discord
// and Slack destinations are sent through their incoming webhooks.
export type NotifierFactory = (
  transport: HttpFetch,
  secrets: SecretProvider,
) => Readonly<Record<DestinationChannel, Notifier>>;

export const webhookNotifiers: NotifierFactory = (transport, secrets) => ({
  discord: createWebhookNotifier("discord", transport, secrets),
  slack: createWebhookNotifier("slack", transport, secrets),
});

export interface PinnedEgress {
  resolve(hostname: string): Promise<readonly string[]>;
  fetchPinned(request: Request, address: string): Promise<Response>;
}

// Everything a platform entry point resolves before the pipeline runs one event. The pipeline
// itself never sees a platform binding or client.
export interface PipelineDeployment {
  readonly settings: RuntimeEnv;
  readonly deskOrigin: string;
  readonly storage: StorageRepositories;
  readonly jobs: JobBus;
  readonly blobs: BlobStore;
  readonly providerSecrets: SecretProvider;
  readonly providerHttp: { fetch: HttpFetch };
  readonly pinnedWeb: PinnedEgress;
  readonly llm: LlmProviders;
  readonly notifiers?: NotifierFactory | undefined;
}

export interface PipelineMessage {
  readonly body: unknown;
  readonly timestamp?: Date | undefined;
  readonly attempts?: number | undefined;
  ack(): void;
  retry(): void;
}

// Decodes one delivered message into the job it carries, rejecting with MESSAGE_INVALID.
export type JobDecoder = (queue: QueueName, message: PipelineMessage) => Job;

export interface RuntimePorts {
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly telemetry: Telemetry;
}

export interface Pipeline {
  tick(event: TickEvent, deployment: PipelineDeployment): Promise<void>;
  consume(
    queue: QueueName,
    messages: readonly PipelineMessage[],
    deployment: PipelineDeployment,
    decode: JobDecoder,
  ): Promise<void>;
  // Stores a reader's submission and queues its analysis. Rejects with INPUT_INVALID when the
  // input does not satisfy the submission contract.
  submit(
    input: SubmissionInput,
    submitter: Submitter,
    deployment: PipelineDeployment,
  ): Promise<SubmissionResult>;
  // The submissions dashboard: every submission in any state, newest first, at most `limit`.
  listSubmissions(
    input: { readonly limit?: number | undefined },
    deployment: PipelineDeployment,
  ): Promise<SubmissionList>;
  // Pushes a rejected, failed, or feed-only submission to deep analysis and delivery regardless
  // of the reviewer, recording the caller's public name. Rejects with NOT_FOUND for an unknown
  // item and INPUT_INVALID for one in a state that cannot be forced.
  forceSubmission(
    itemId: string,
    forcer: Submitter,
    deployment: PipelineDeployment,
  ): Promise<SubmissionSummary>;
}

interface Work extends Omit<StorageRepositories, "config">, RuntimePorts {
  readonly config: AppConfig;
  readonly configVersion: number;
  readonly logger: Logger;
  readonly providerSecrets: SecretProvider;
  readonly deskOrigin: string;
  readonly jobs: JobBus;
  readonly blobs: BlobStore;
  readonly providerHttp: { fetch: HttpFetch };
  readonly web: WebFetcher;
  readonly llm: LlmProviders;
  readonly notifiers: NotifierFactory;
}

export function createPipeline(runtime: RuntimePorts): Pipeline {
  const ports = { ...runtime, telemetry: bestEffortTelemetry(runtime.telemetry) };
  return {
    async submit(input, submitter, deployment) {
      const work = await loadWork(deployment, ports);
      return submitItem(work, input, submitter, { deskOrigin: work.deskOrigin });
    },
    // Neither dashboard call needs the model, web, or notifier wiring, so they skip `loadWork`
    // and keep working while the pipeline configuration is unpublished or invalid.
    listSubmissions(input, deployment) {
      return listSubmissions(deployment.storage, {
        limit: input.limit,
        deskOrigin: deployment.deskOrigin,
        legacyRejectionReason: legacyRejectionReason(deployment.storage.analyses),
      });
    },
    forceSubmission(itemId, forcer, deployment) {
      return forceSubmission(
        { ...deployment.storage, jobs: deployment.jobs, clock: ports.clock, ids: ports.ids },
        itemId,
        forcer,
        {
          deskOrigin: deployment.deskOrigin,
          legacyRejectionReason: legacyRejectionReason(deployment.storage.analyses),
        },
      );
    },
    async tick(event, deployment) {
      const work = await loadWork(deployment, ports);
      const [dispatch, refresh, sweep] = await Promise.allSettled([
        dispatchDueSources(work, event, TICK_LIMIT),
        refreshPublishedItems(work, work.config.ai, TICK_LIMIT),
        sweepStaleWork(work, { config: work.config, limit: TICK_LIMIT }),
      ]);
      if (dispatch.status === "rejected") {
        work.logger.error("pipeline.dispatch_failed", {
          stage: "tick",
          err: codeOnlyError(dispatch.reason),
        });
      }
      if (refresh.status === "rejected") {
        work.logger.error("pipeline.refresh_failed", {
          stage: "tick",
          err: codeOnlyError(refresh.reason),
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
      if (refresh.status === "rejected") throw toAppError(refresh.reason);
    },
    async consume(queue, messages, deployment, decode) {
      const work = await loadWork(deployment, ports);
      for (const [index, message] of messages.entries()) {
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
          job = decode(queue, message);
          context = jobContext(job);
          await runJob(work, job, context);
        } catch (cause) {
          const duration = Math.max(0, work.clock.now() - startedAt);
          const outcome = messageDisposition(cause);
          work.logger.error("pipeline.message_failed", {
            ...context,
            err: codeOnlyError(cause),
            duration_ms: duration,
            attrs: { queue, index, attempt: validAttempt(attempt), outcome },
          });
          if (outcome === "ack") {
            message.ack();
          } else {
            message.retry();
          }
          work.telemetry.count("pipeline.queue.disposition", 1, { queue, outcome });
          if (job !== undefined) {
            work.telemetry.count("pipeline.job.duration_ms", duration, {
              stage: job.type,
              outcome,
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
}

// Submissions rejected before the reviewer existed carry no review; the triage analysis row keyed
// by the item as it was then still holds the model's rejection reason.
function legacyRejectionReason(
  analyses: Pick<AnalysisRepo, "findByKey">,
): (item: Item) => Promise<string | null> {
  return async (item) => {
    const row = await analyses.findByKey(executionKey(item.id, "triage", itemSnapshotHash(item)));
    const assessment = row === null ? null : readOutput(row, TriageAssessmentSchema);
    return assessment?.decision === "reject" ? assessment.rejection_reason : null;
  };
}

// Public repositories can be read without a token, at GitHub's lower unauthenticated rate limit,
// so a deployment without GITHUB_TOKEN still polls; any other secret failure still fails the job.
async function optionalSecret(secrets: SecretProvider, ref: string): Promise<string | undefined> {
  try {
    return await secrets.get(ref);
  } catch (cause) {
    if (isAppError(cause) && cause.code === "SECRET_MISSING") return undefined;
    throw cause;
  }
}

export function codeOnlyError(cause: unknown): AppError {
  return new AppError(toAppError(cause).code);
}

// What the consumer does with a message whose job threw. The correctness store holds the work, so
// a failure whose kind cannot succeed again is dropped rather than redelivered. Anything
// unclassified may be a platform hiccup and keeps the platform's retries.
export function messageDisposition(cause: unknown): "retry" | "ack" {
  if (!isAppError(cause)) return "retry";
  return cause.kind === "retryable" || cause.kind === "ambiguous" ? "retry" : "ack";
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

// Which providers a deployment admits depends on the adapters its entry point wires, so admission
// belongs to the composition root rather than to the portable configuration schema.
export function deploymentConfigIssue(
  config: AppConfig,
  providers: readonly string[],
): string | undefined {
  const routes = Object.values(config.models);
  const provider = config.models.triage.provider;
  if (routes.some((route) => route.provider !== provider)) {
    return "Pipeline models must all use one provider";
  }
  for (const route of [...routes, ...routes.flatMap((primary) => primary.fallback_routes)]) {
    if (!providers.includes(route.provider)) {
      return `Pipeline models must use one of: ${providers.join(", ")}`;
    }
    if (route.provider === "openrouter" && route.effort !== undefined) {
      return "OpenRouter routes take no effort";
    }
    if (route.provider === "hyper" && (route.effort === "medium" || route.effort === "xhigh")) {
      return "Hyper routes take only low, high, or max effort";
    }
  }
  return pipelineConfigIssue(config);
}

function canSwitchProvider(error: unknown): boolean {
  if (!isAppError(error)) return false;
  return (
    error.code === "SECRET_MISSING" ||
    error.code === "UPSTREAM_RATE_LIMITED" ||
    error.code === "UPSTREAM_UNAVAILABLE" ||
    error.code === "UPSTREAM_TIMEOUT" ||
    error.code === "UPSTREAM_RESPONSE_INVALID" ||
    error.code === "LLM_OUTPUT_INVALID" ||
    (error.code === "UPSTREAM_REJECTED" && error.context["status"] === 402)
  );
}

function sumUsage(previous: LlmUsage, reported: Readonly<LlmUsage>): LlmUsage {
  return {
    input_tokens: previous.input_tokens + reported.input_tokens,
    output_tokens: previous.output_tokens + reported.output_tokens,
    cost_usd:
      previous.cost_usd === null || reported.cost_usd === null
        ? null
        : previous.cost_usd + reported.cost_usd,
  };
}

export async function createRoutedLlmClient(
  providers: LlmProviders,
  input: LlmFactoryInput,
  logger?: Pick<Logger, "info">,
): Promise<LlmClient> {
  const primary = providers[input.models.triage.provider];
  if (primary === undefined) throw new AppError("CONFIG_INVALID");
  if (Object.values(input.models).every((route) => route.fallback_routes.length === 0)) {
    return primary(input);
  }
  return {
    async generateStructured<Output>(request: GenerateStructuredRequest<Output>) {
      const { stage } = request;
      const route = input.models[stage];
      let usage: LlmUsage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
      const observedRequest: GenerateStructuredRequest<Output> = {
        ...request,
        onUsage(reported) {
          usage = sumUsage(usage, reported);
          request.onUsage?.(reported);
        },
      };
      try {
        const client = await primary(input);
        return await client.generateStructured(observedRequest);
      } catch (error) {
        let failure = error;
        let fromProvider = route.provider;
        for (const fallback of route.fallback_routes) {
          if (!canSwitchProvider(failure)) break;
          const factory = providers[fallback.provider];
          if (factory === undefined) throw new AppError("CONFIG_INVALID");
          if (fromProvider !== fallback.provider) {
            logger?.info("pipeline.llm_provider_switched", {
              stage,
              attrs: {
                from_provider: fromProvider,
                to_provider: fallback.provider,
                code: codeOnlyError(failure).code,
              },
            });
          }
          const models = {
            ...input.models,
            [stage]: {
              ...fallback,
              max_output_tokens: route.max_output_tokens,
              fallback_routes: [],
            },
          };
          const priorUsage = usage;
          try {
            const client = await factory({ ...input, models });
            const result = await client.generateStructured(observedRequest);
            // The successful provider already included all its attempts in the result.
            return { ...result, usage: sumUsage(priorUsage, result.usage), usedFallback: true };
          } catch (next) {
            failure = next;
            fromProvider = fallback.provider;
          }
        }
        throw failure;
      }
    },
  };
}

async function loadWork(deployment: PipelineDeployment, runtime: RuntimePorts): Promise<Work> {
  const { settings, storage, pinnedWeb } = deployment;
  const persisted = await storage.config.getCurrent();
  if (persisted === null) {
    throw new AppError("CONFIG_INVALID", { message: "No published pipeline configuration" });
  }
  const config = loadAppConfig(persisted.config);
  const issue = deploymentConfigIssue(config, Object.keys(deployment.llm));
  if (issue !== undefined) {
    throw new AppError("CONFIG_INVALID", { message: issue });
  }
  const web = createWebFetcher({
    config: config.web_fetch,
    timeoutMs: config.timeouts.web_fetch_ms,
    resolve: (hostname) => pinnedWeb.resolve(hostname),
    fetchPinned: ({ request, address }) => pinnedWeb.fetchPinned(request, address),
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
    providerSecrets: deployment.providerSecrets,
    deskOrigin: deployment.deskOrigin,
    jobs: deployment.jobs,
    blobs: deployment.blobs,
    providerHttp: deployment.providerHttp,
    web,
    llm: deployment.llm,
    notifiers: deployment.notifiers ?? webhookNotifiers,
  };
}

async function runJob(work: Work, job: Job, context: LogContext): Promise<void> {
  const { config, providerHttp } = work;
  const transport = (request: Request): Promise<Response> => providerHttp.fetch(request);
  const logger = work.logger.child(context);
  switch (job.type) {
    case "poll": {
      const githubToken = await optionalSecret(work.providerSecrets, GITHUB_SECRET);
      const result = await pollSource(
        {
          ...work,
          hn: createHnClient({
            fetch: transport,
            timeoutMs: config.timeouts.hn_ms,
            concurrency: config.hn.fetch_concurrency,
          }),
          github: createGitHubClient({
            fetch: transport,
            ...(githubToken === undefined ? {} : { token: githubToken }),
            timeoutMs: config.timeouts.github_ms,
          }),
          ...(config.ai.enabled
            ? {
                judgeHnRelevance: createHnRelevanceJudge({
                  llm: () =>
                    createRoutedLlmClient(
                      work.llm,
                      {
                        models: stageModels(config.models),
                        timeoutMs: Math.min(config.timeouts.llm_ms, config.hn.relevance.timeout_ms),
                        secrets: work.providerSecrets,
                        transport,
                      },
                      work.logger,
                    ),
                  profile: config.profile,
                  logger,
                  traceId: job.trace_id,
                }),
              }
            : {}),
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
      if (!config.ai.enabled) return;
      const llm = await createRoutedLlmClient(
        work.llm,
        {
          models: stageModels(config.models),
          timeoutMs: config.timeouts.llm_ms,
          secrets: work.providerSecrets,
          transport,
        },
        work.logger,
      );
      const observed = {
        ...work,
        llm,
        items: observeItems(work.items, logger, job.type),
        analyses: observeAnalyses(work.analyses, logger, job.type),
      };
      if (job.type === "triage") return processTriage(observed, job);
      const deps: DeepDependencies = {
        ...observed,
        hn: createHnClient({
          fetch: transport,
          timeoutMs: config.timeouts.hn_ms,
          concurrency: config.hn.fetch_concurrency,
        }),
        detailUrl: (itemId) => `${work.deskOrigin}/items/${encodeURIComponent(itemId)}`,
        finalize: makeFinalizer(work),
      };
      return processDeep(deps, job);
    }
    case "deliver": {
      const id = job.delivery_id;
      if (!config.delivery.feed_only) {
        await executeDelivery(
          {
            ...work,
            notifiers: work.notifiers(transport, work.providerSecrets),
          },
          id,
          config,
        );
        return;
      }
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
  return async (request) => {
    // Once the rollout switch is off, an alert that says send is planned against the
    // enabled destinations and queued, which is what the delivery package is for.
    if (!work.config.delivery.feed_only) {
      const { alert, documents, item, config, traceId } = request;
      const now = work.clock.now();
      const deliveries = planDeliveries({
        alert,
        documents,
        destinations: await work.destinations.list(),
        itemKind: item.kind,
        now,
        expiryHours: config.delivery.expiry_hours[item.kind],
        quietHours: config.delivery.quiet_hours,
        forceDryRun: config.delivery.force_dry_run,
        ids: work.ids,
      });
      return finalizeAlert(work, { alert, deliveries, documents, traceId });
    }
    const { alert, documents } = request;
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
    // A refresh re-reaches the same alert key. The alert row stays; its documents
    // are overwritten so the page always shows the latest reading.
    if (!stored.created && stored.value.analysis_id === alert.analysis_id && documents.length > 0) {
      await work.alerts.replaceDocuments(
        stored.value.id,
        documents.map((document) => ({ ...document, alert_id: stored.value.id })),
      );
    }
    return stored.value;
  };
}

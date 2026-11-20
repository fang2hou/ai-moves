import type { AppConfig } from "@ai-moves/contracts/config";
import type { Source, SourceCursor } from "@ai-moves/contracts/entities";
import type { ErrorSummary } from "@ai-moves/contracts/errors";
import type { PollJob, TriageJob } from "@ai-moves/contracts/messages";
import type { Clock, IdGen, JobBus } from "@ai-moves/contracts/ports/runtime";
import type { GitHubClient, HnClient } from "@ai-moves/contracts/ports/sources";
import type {
  BlobStore,
  ItemRepo,
  ItemRevisionRepo,
  ItemSnapshotRepo,
  SourceRepo,
} from "@ai-moves/contracts/ports/storage";
import { stableKey } from "@ai-moves/core/idempotency";
import { summarizeError, toAppError } from "@ai-moves/kernel/errors/app-error";

import { observeGitHub, readGitHub, type GitHubPoll } from "./github.ts";
import { hnTrackingIds, observeHn, readHn, type RankedStories } from "./hn.ts";
import { POLL_BUCKET_MS, publishJobs } from "./jobs.ts";
import type { ObservationState } from "./observations.ts";

export interface PollPorts {
  readonly sources: Pick<SourceRepo, "claimPoll" | "finishPoll">;
  readonly items: Pick<ItemRepo, "upsertObserved" | "transition" | "listBySourceAndStates">;
  readonly snapshots: Pick<ItemSnapshotRepo, "insertIfAbsent" | "listSince">;
  readonly revisions: Pick<ItemRevisionRepo, "insertIfAbsent" | "listByItem">;
  readonly blobs: Pick<BlobStore, "get" | "put">;
  readonly hn: HnClient;
  readonly github: GitHubClient;
  readonly jobs: JobBus;
  readonly clock: Clock;
  readonly ids: IdGen;
}

export interface PollOptions {
  readonly config: Pick<AppConfig, "hn" | "changelog" | "delivery" | "retry">;
  readonly leaseMs: number;
}

export type PollResult =
  | { readonly status: "not_claimed" | "claim_lost" | "completed" }
  | { readonly status: "backoff"; readonly error: ErrorSummary };

type UpstreamPoll =
  | { readonly kind: "hn"; readonly stories: RankedStories }
  | { readonly kind: "github"; readonly batch: GitHubPoll };

export async function pollSource(
  ports: PollPorts,
  job: PollJob,
  options: PollOptions,
): Promise<PollResult> {
  const work = { source_id: job.source_id, tick_bucket: job.tick_bucket };
  const now = ports.clock.now();
  const owner = ports.ids.next();
  const expiresAt = now + options.leaseMs;
  const source = await ports.sources.claimPoll(work, { owner, now, expiresAt });
  if (source === null) return { status: "not_claimed" };

  const sampledAt = job.tick_bucket * POLL_BUCKET_MS;
  const tracked =
    source.config_json.kind === "hn_top"
      ? await hnTrackingIds(ports.items, source.id, source.config_json.track_limit)
      : [];
  const currentTime = (): number => ports.clock.now();
  const state: ObservationState = {
    items: ports.items,
    sampledAt,
    beforeExpiry: () => currentTime() < expiresAt,
    now: currentTime,
  };
  if (!state.beforeExpiry()) return { status: "claim_lost" };

  let upstream: UpstreamPoll;
  try {
    upstream =
      source.config_json.kind === "hn_top"
        ? {
            kind: "hn",
            stories: await readHn(ports.hn, source.config_json, tracked, options.config.hn),
          }
        : {
            kind: "github",
            batch: await readGitHub(ports.github, source.config_json, source.cursor_json),
          };
  } catch (error) {
    const at = currentTime();
    const failure = toAppError(error);
    const retry = options.config.retry.poll;
    const consecutiveFailures = source.consecutive_failures + 1;
    const retainedClaim = await ports.sources.finishPoll(work, owner, {
      at,
      next_poll_at: at + pollBackoff(source, consecutiveFailures, retry, failure.retryAfterMs),
      consecutive_failures: consecutiveFailures,
      status: consecutiveFailures >= retry.degraded_after_failures ? "degraded" : source.status,
    });
    return retainedClaim
      ? { status: "backoff", error: summarizeError(failure) }
      : { status: "claim_lost" };
  }

  if (!state.beforeExpiry()) return { status: "claim_lost" };
  const candidates = new Set<string>();
  let cursor: SourceCursor = source.cursor_json;
  if (upstream.kind === "hn") {
    await observeHn(
      state,
      ports.snapshots,
      source.id,
      upstream.stories,
      options.config.hn,
      candidates,
    );
  } else {
    cursor = await observeGitHub(
      state,
      ports,
      source.id,
      upstream.batch,
      options.config,
      candidates,
    );
  }

  const at = currentTime();
  const retainedClaim = await ports.sources.finishPoll(work, owner, {
    at,
    cursor_json: cursor,
    consecutive_failures: 0,
    status: "active",
    last_success_at: at,
    next_poll_at: at + source.poll_interval_sec * 1000,
  });
  if (!retainedClaim) return { status: "claim_lost" };

  await publishJobs(
    ports.jobs,
    Array.from(candidates, (itemId): TriageJob => ({
      v: 1,
      type: "triage",
      item_id: itemId,
      trace_id: job.trace_id,
    })),
  );
  return { status: "completed" };
}

function pollBackoff(
  source: Source,
  failures: number,
  config: AppConfig["retry"]["poll"],
  retryAfterMs: number | undefined,
): number {
  const cap = config.max_backoff_seconds * 1000;
  const base = source.poll_interval_sec * 1000 * 2 ** Math.min(failures - 1, 52);
  const fraction = Number.parseInt(stableKey(source.id, String(failures)).slice(0, 4), 16) / 0xffff;
  return Math.min(cap, Math.max(Math.floor(base * (1 + 0.1 * fraction)), retryAfterMs ?? 0));
}

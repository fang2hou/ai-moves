import { POLL_INTERVAL_STEP_SEC } from "@ai-moves/contracts/entities";
import type { DeepJob, TriageJob } from "@ai-moves/contracts/messages";
import type { Clock, IdGen, JobBus } from "@ai-moves/contracts/ports/runtime";
import type {
  BlobStore,
  ItemRepo,
  ItemRevisionRepo,
  SourceRepo,
} from "@ai-moves/contracts/ports/storage";
import { SubmitterSchema, type SubmissionScore, type Submitter } from "@ai-moves/contracts/scoring";
import {
  SubmissionInputSchema,
  type SubmissionInput,
  type SubmissionResult,
} from "@ai-moves/contracts/submission";
import { canonicalClusterUrl, clusterKey } from "@ai-moves/core/clustering";
import { itemKey, stableKey } from "@ai-moves/core/idempotency";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { observedSourceUrl } from "@ai-moves/kernel/public-links";

import { publishJobs } from "./jobs.ts";

// The one source row every submitted item belongs to. It is never polled: `next_poll_at` stays in
// the far future, and `pollSource` finishes a claimed poll of it without reading anything.
export const SUBMISSION_SOURCE_ID = "submission";
// 9999-12-31T23:59:59Z; a point no clock reaches.
export const SUBMISSION_NEXT_POLL_AT = 253_402_300_799_000;
const SUBMISSION_POLL_INTERVAL_SEC = POLL_INTERVAL_STEP_SEC * 288;
const MARKDOWN_TYPE = "text/markdown; charset=utf-8";

export interface SubmissionPorts {
  readonly sources: Pick<SourceRepo, "get" | "upsert">;
  readonly items: Pick<ItemRepo, "upsertObserved" | "get" | "transition">;
  readonly revisions: Pick<ItemRevisionRepo, "insertIfAbsent">;
  readonly blobs: Pick<BlobStore, "put">;
  readonly jobs: JobBus;
  readonly clock: Clock;
  readonly ids: IdGen;
}

export interface SubmissionOptions {
  // Origin of the public desk, without a trailing slash.
  readonly deskOrigin: string;
}

// One item exists per page, so the key follows the page and ignores fragments, `utm_*`
// parameters, parameter order, and host case.
export function submissionExternalKey(sourceUrl: string): string {
  return `submission:${stableKey(canonicalClusterUrl(sourceUrl))}`;
}

export function submissionDetailUrl(deskOrigin: string, itemId: string): string {
  return `${deskOrigin}/items/${encodeURIComponent(itemId)}`;
}

// Stores a reader's markdown as a new `submission` item and hands it to analysis: `score` goes
// through triage, `publish` skips straight to deep analysis. A page that was already submitted
// returns its existing item. A lost enqueue is recovered by the sweep of stale ready items.
export async function submitItem(
  ports: SubmissionPorts,
  input: SubmissionInput,
  submitter: Submitter,
  options: SubmissionOptions,
): Promise<SubmissionResult> {
  const request = parseBoundary(SubmissionInputSchema, input, "INPUT_INVALID");
  const who = parseBoundary(SubmitterSchema, submitter, "INPUT_INVALID");
  // A URL with credentials would be published as the item's link.
  if (observedSourceUrl(request.source_url) === null) {
    throw new AppError("INPUT_INVALID", { message: "INPUT_INVALID: source_url (not_public_link)" });
  }
  const now = ports.clock.now();

  if ((await ports.sources.get(SUBMISSION_SOURCE_ID)) === null) {
    // Idempotent on `key`: a concurrent first submission keeps the row that won.
    await ports.sources.upsert({
      id: SUBMISSION_SOURCE_ID,
      key: SUBMISSION_SOURCE_ID,
      kind: "submission",
      config_json: { kind: "submission" },
      poll_interval_sec: SUBMISSION_POLL_INTERVAL_SEC,
      next_poll_at: SUBMISSION_NEXT_POLL_AT,
      cursor_json: { kind: "submission" },
      created_at: now,
      updated_at: now,
    });
  }

  const url = canonicalClusterUrl(request.source_url);
  const externalKey = submissionExternalKey(url);
  const { value: item } = await ports.items.upsertObserved({
    id: itemKey(externalKey),
    source_id: SUBMISSION_SOURCE_ID,
    external_key: externalKey,
    kind: "submission",
    url,
    title: request.title,
    published_at: request.published_at,
    observed_at: now,
    state: "discovered",
  });
  const detailUrl = submissionDetailUrl(options.deskOrigin, item.id);
  const existing = (current: typeof item): SubmissionResult => ({
    item_id: current.id,
    created: false,
    state: current.state,
    submitted_by:
      current.score_json?.kind === "submission" ? current.score_json.submitter.name : who.name,
    detail_url: detailUrl,
  });
  // Anything past `discovered` was submitted before. A row stuck in `discovered` is a submission
  // that crashed before it was stored, and this call completes it.
  if (item.state !== "discovered") return existing(item);

  const body = request.body.replace(/\r\n?/gu, "\n");
  const ref = await ports.blobs.put(body, { contentType: MARKDOWN_TYPE });
  await ports.revisions.insertIfAbsent({
    item_id: item.id,
    content_hash: ref.content_hash,
    origin: "submission",
    blob_key: ref.key,
    observed_at: now,
  });
  const score: SubmissionScore = {
    kind: "submission",
    mode: request.mode,
    submitter: who,
    source_name: request.source_name,
    computed_at: now,
  };
  const to = request.mode === "publish" ? "triaged_pass" : "candidate";
  const won = await ports.items.transition({
    id: item.id,
    from: "discovered",
    to,
    at: now,
    expected: item,
    patch: {
      content_hash: ref.content_hash,
      revision: 1,
      score_json: score,
      cluster_id: clusterKey({
        kind: "submission",
        externalKey,
        title: item.title,
        url: item.url,
      }),
      next_attempt_at: null,
    },
  });
  if (!won) {
    const settled = await ports.items.get(item.id);
    if (settled === null) throw new AppError("STATE_CONFLICT");
    return existing(settled);
  }

  const job: DeepJob | TriageJob = {
    v: 1,
    type: request.mode === "publish" ? "deep" : "triage",
    item_id: item.id,
    trace_id: ports.ids.next(),
  };
  await publishJobs(ports.jobs, [job]);
  return {
    item_id: item.id,
    created: true,
    state: to,
    submitted_by: who.name,
    detail_url: detailUrl,
  };
}

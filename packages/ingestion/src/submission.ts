import { POLL_INTERVAL_STEP_SEC, type Item } from "@ai-moves/contracts/entities";
import type { DeepJob, TriageJob } from "@ai-moves/contracts/messages";
import type { Clock, IdGen, JobBus } from "@ai-moves/contracts/ports/runtime";
import type {
  AlertRepo,
  DeliveryRepo,
  BlobStore,
  ItemRepo,
  ItemRevisionRepo,
  SourceRepo,
} from "@ai-moves/contracts/ports/storage";
import { SubmitterSchema, type SubmissionScore, type Submitter } from "@ai-moves/contracts/scoring";
import { DELIVERY_TERMINAL_STATES, ITEM_STATES, type ItemState } from "@ai-moves/contracts/states";
import {
  FORCEABLE_SUBMISSION_STATES,
  SubmissionInputSchema,
  SubmissionListSchema,
  SubmissionSummarySchema,
  type SubmissionInput,
  type SubmissionList,
  type SubmissionResult,
  type SubmissionSummary,
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

export interface SubmissionListPorts {
  readonly items: Pick<ItemRepo, "listBySourceAndStates">;
  readonly alerts: Pick<AlertRepo, "listFeed">;
  readonly deliveries: Pick<DeliveryRepo, "listByAlert">;
}

export interface SubmissionForcePorts {
  readonly items: Pick<ItemRepo, "get" | "transition">;
  readonly alerts: Pick<AlertRepo, "listFeed">;
  readonly deliveries: Pick<DeliveryRepo, "listByAlert">;
  readonly jobs: JobBus;
  readonly clock: Clock;
  readonly ids: IdGen;
}

export interface SubmissionViewOptions extends SubmissionOptions {
  // The reason an older triage model gave for rejecting an item, for rejections that predate the
  // reviewer and so carry no review. Ingestion cannot compute the analysis row's key, so the
  // composition root supplies the lookup; null when the item has no such reason.
  readonly legacyRejectionReason?: ((item: Item) => Promise<string | null>) | undefined;
}

export interface SubmissionListOptions extends SubmissionViewOptions {
  readonly limit?: number | undefined;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
// The largest page any item repository returns for one query.
const STATE_PAGE_LIMIT = 100;

// One item exists per page, so the key follows the page and ignores fragments, `utm_*`
// parameters, parameter order, and host case.
export function submissionExternalKey(sourceUrl: string): string {
  return `submission:${stableKey(canonicalClusterUrl(sourceUrl))}`;
}

export function submissionDetailUrl(deskOrigin: string, itemId: string): string {
  return `${deskOrigin}/items/${encodeURIComponent(itemId)}`;
}

// The name is published, so an identity provider that puts the account email in the display name
// must not leak it: the verified address is removed, anything still shaped like an address is cut
// at its @, and an empty result falls back to the address's local part.
function publicDisplayName({ name, email }: Submitter): string {
  let shown = name;
  if (email !== null) {
    const at = shown.toLowerCase().indexOf(email.toLowerCase());
    if (at !== -1) shown = shown.slice(0, at) + shown.slice(at + email.length);
  }
  const address = shown.search(/[^\s@]@[^\s@]/u);
  if (address !== -1) shown = shown.slice(0, address + 1);
  // Only a name an address was cut out of loses the punctuation that framed the address.
  if (shown !== name) {
    shown = shown.replace(/\(\s*\)|<\s*>|\[\s*\]/gu, "").replace(/[\s(<[@,;:]+$/u, "");
  }
  shown = shown.trim();
  if (shown !== "") return shown;
  return email?.slice(0, email.indexOf("@")) ?? "anonymous";
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
  const sourceUrl = observedSourceUrl(request.source_url);
  if (sourceUrl === null) {
    throw new AppError("INPUT_INVALID", { message: "INPUT_INVALID: source_url (not_public_link)" });
  }
  const publicName = publicDisplayName(who);
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

  // The canonical form only keys the item: re-encoding can push a valid URL past the stored
  // length limit, so the item keeps the URL that was validated.
  const externalKey = submissionExternalKey(canonicalClusterUrl(request.source_url));
  const { value: item } = await ports.items.upsertObserved({
    id: itemKey(externalKey),
    source_id: SUBMISSION_SOURCE_ID,
    external_key: externalKey,
    kind: "submission",
    url: sourceUrl,
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
      current.score_json?.kind === "submission" ? current.score_json.submitter.name : publicName,
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
    submitter: { name: publicName, email: who.email },
    source_name: request.source_name,
    review: null,
    forced_by: null,
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
    submitted_by: publicName,
    detail_url: detailUrl,
  };
}

function isForceable(state: ItemState): boolean {
  return (FORCEABLE_SUBMISSION_STATES as readonly ItemState[]).includes(state);
}

// The view carries only the public name, the verdict, and the alert's outcome, never the email.
async function summarize(
  ports: Pick<SubmissionListPorts, "alerts" | "deliveries">,
  item: Item,
  score: SubmissionScore,
  options: SubmissionViewOptions,
): Promise<SubmissionSummary> {
  let review: SubmissionSummary["review"] = score.review;
  if (review === null && item.state === "triaged_reject") {
    const reason = await options.legacyRejectionReason?.(item);
    if (reason !== undefined && reason !== null) {
      review = { decision: "reject", score: null, comment: reason };
    }
  }
  const [latest] = await ports.alerts.listFeed({ itemId: item.id, limit: 1 });
  const deliveries = latest === undefined ? [] : await ports.deliveries.listByAlert(latest.id);
  const delivery = deliveries.some(({ state, dry_run }) => state === "sent" && !dry_run)
    ? "sent"
    : deliveries.some(({ state }) => !DELIVERY_TERMINAL_STATES.includes(state))
      ? "in_flight"
      : deliveries.some(({ state }) => state === "unknown")
        ? "unconfirmed"
        : "held";
  return SubmissionSummarySchema.parse({
    item_id: item.id,
    title: item.title,
    url: item.url,
    source_name: score.source_name,
    submitted_by: score.submitter.name,
    mode: score.mode,
    state: item.state,
    submitted_at: item.first_seen_at,
    review,
    alert:
      latest === undefined
        ? null
        : {
            decision: latest.decision,
            blocked_by: latest.decision_reason_json.blocked_by,
            importance: latest.decision_reason_json.importance,
            delivery,
          },
    forced_by: score.forced_by,
    can_force: isForceable(item.state),
    can_rereview: item.state === "triaged_reject",
    detail_url: submissionDetailUrl(options.deskOrigin, item.id),
  });
}

// The dashboard's rows: submissions in every state, newest first. A repository returns a state's
// items in id order and caps each query, so each state is read separately and a state holding
// more than 100 submissions contributes an arbitrary 100 of them.
export async function listSubmissions(
  ports: SubmissionListPorts,
  options: SubmissionListOptions,
): Promise<SubmissionList> {
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new AppError("INPUT_INVALID", { message: "INPUT_INVALID: limit (invalid)" });
  }
  const pages = await Promise.all(
    ITEM_STATES.map((state) =>
      ports.items.listBySourceAndStates(SUBMISSION_SOURCE_ID, [state], STATE_PAGE_LIMIT),
    ),
  );
  const newest = pages
    .flat()
    .toSorted((left, right) => right.first_seen_at - left.first_seen_at)
    .slice(0, Math.min(limit, MAX_LIST_LIMIT));
  const submissions: SubmissionSummary[] = [];
  for (const item of newest) {
    // A row still in `discovered` crashed before it stored a submitter.
    if (item.kind !== "submission" || item.score_json?.kind !== "submission") continue;
    submissions.push(await summarize(ports, item, item.score_json, options));
  }
  return SubmissionListSchema.parse({ submissions });
}

// Sends a rejected submission back through the current reviewer, for when the reviewer's rules
// changed or its verdict looks wrong. The old review is dropped; the new revision gives triage a
// fresh analysis key, so the reviewer runs again instead of replaying its stored verdict.
export async function rereviewSubmission(
  ports: SubmissionForcePorts,
  itemId: string,
  options: SubmissionViewOptions,
): Promise<SubmissionSummary> {
  const item = await ports.items.get(itemId);
  if (item === null || item.kind !== "submission" || item.score_json?.kind !== "submission") {
    throw new AppError("NOT_FOUND");
  }
  if (item.state !== "triaged_reject") {
    throw new AppError("INPUT_INVALID", {
      message: `INPUT_INVALID: item_id (cannot_rereview_from_${item.state})`,
    });
  }
  const score: SubmissionScore = { ...item.score_json, mode: "score", review: null };
  const now = ports.clock.now();
  const revision = item.revision + 1;
  const won = await ports.items.transition({
    id: item.id,
    from: "triaged_reject",
    to: "candidate",
    at: now,
    expected: item,
    patch: { score_json: score, revision, attempts: 0, next_attempt_at: null },
  });
  if (!won) throw new AppError("STATE_CONFLICT");

  const job: TriageJob = { v: 1, type: "triage", item_id: item.id, trace_id: ports.ids.next() };
  await publishJobs(ports.jobs, [job]);
  return summarize(
    ports,
    {
      ...item,
      state: "candidate",
      state_updated_at: now,
      score_json: score,
      revision,
      attempts: 0,
      next_attempt_at: null,
    },
    score,
    options,
  );
}

// Sends a rejected, failed, or feed-only submission straight to deep analysis and delivery,
// whatever the reviewer decided. The revision bump gives deep analysis a new input: a rejected
// item gets its first alert, and a feed-only item gets an update alert that `publish` mode
// sends. The forcer's public name is recorded on the item.
export async function forceSubmission(
  ports: SubmissionForcePorts,
  itemId: string,
  forcer: Submitter,
  options: SubmissionViewOptions,
): Promise<SubmissionSummary> {
  const who = parseBoundary(SubmitterSchema, forcer, "INPUT_INVALID");
  const item = await ports.items.get(itemId);
  if (item === null || item.kind !== "submission" || item.score_json?.kind !== "submission") {
    throw new AppError("NOT_FOUND");
  }
  if (!isForceable(item.state)) {
    throw new AppError("INPUT_INVALID", {
      message: `INPUT_INVALID: item_id (cannot_force_from_${item.state})`,
    });
  }
  const score: SubmissionScore = {
    ...item.score_json,
    mode: "publish",
    forced_by: publicDisplayName(who),
  };
  const now = ports.clock.now();
  const revision = item.revision + 1;
  const won = await ports.items.transition({
    id: item.id,
    from: item.state,
    to: "triaged_pass",
    at: now,
    expected: item,
    patch: { score_json: score, revision, attempts: 0, next_attempt_at: null },
  });
  if (!won) throw new AppError("STATE_CONFLICT");

  const job: DeepJob = { v: 1, type: "deep", item_id: item.id, trace_id: ports.ids.next() };
  await publishJobs(ports.jobs, [job]);
  return summarize(
    ports,
    {
      ...item,
      state: "triaged_pass",
      state_updated_at: now,
      score_json: score,
      revision,
      attempts: 0,
      next_attempt_at: null,
    },
    score,
    options,
  );
}

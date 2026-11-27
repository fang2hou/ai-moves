import { TriageAssessmentSchema } from "@ai-moves/contracts/analysis";
import type { Item } from "@ai-moves/contracts/entities";
import type { TriageJob } from "@ai-moves/contracts/messages";
import type { JobBus } from "@ai-moves/contracts/ports/runtime";
import { LangSchema } from "@ai-moves/contracts/primitives";
import type { ItemScore, SubmissionReview } from "@ai-moves/contracts/scoring";
import { ItemKindSchema } from "@ai-moves/contracts/states";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import {
  normalizeSubmissionReviewOutput,
  renderSubmissionReviewPrompt,
  SubmissionReviewOutputSchema,
} from "@ai-moves/prompts/review";
import { normalizeTriageOutput, renderTriagePrompt } from "@ai-moves/prompts/triage";
import { SUBMISSION_REVIEW_PROMPT_VERSION } from "@ai-moves/prompts/versions";
import { z } from "zod";

import { readRevision, type RevisionEvidenceDependencies } from "./evidence.ts";
import {
  advanceItem,
  claimItem,
  executionKey,
  itemSnapshotHash,
  readOutput,
  retryItem,
  runAnalysis,
  type AnalysisDependencies,
  type ItemClaim,
} from "./work.ts";

const inputSchema = z.strictObject({
  kind: ItemKindSchema,
  title: z.string(),
  excerpt: z.string().nullable(),
  topics: z.array(z.string()),
});
const reviewInputSchema = z.strictObject({
  title: z.string(),
  sourceUrl: z.string().nullable(),
  sourceName: z.string().nullable(),
  excerpt: z.string().nullable(),
  topics: z.array(z.string()),
  lang: LangSchema,
});
const MAX_EXCERPT_CHARS = 12_000;

export interface TriageDependencies
  extends AnalysisDependencies, Omit<RevisionEvidenceDependencies, "blobs"> {
  readonly jobs: Pick<JobBus, "enqueue">;
}

export async function processTriage(deps: TriageDependencies, job: TriageJob): Promise<void> {
  const item = await deps.items.get(job.item_id);
  if (item === null) return;
  const claim = await claimItem(deps, item, "triage");
  if (claim === null) return;
  if (item.kind === "hn" || (item.kind === "changelog" && deps.config.push.changelog.approve_all)) {
    await passToDeep(deps, claim, job);
    return;
  }
  if (item.kind === "submission") {
    await reviewSubmission(deps, claim, job);
    return;
  }
  const outcome = await runAnalysis(deps, claim, {
    key: triageKey(item),
    inputSchema,
    prepare: async () => {
      const notes = await readRevision(deps, item);
      const maxChars = Math.min(MAX_EXCERPT_CHARS, deps.config.ai.triage_batch_input_tokens * 3);
      return {
        kind: item.kind,
        title: item.title,
        excerpt: notes?.slice(0, maxChars) ?? null,
        topics: deps.config.profile.topics,
      };
    },
    prompt: (input) => renderTriagePrompt({ ...input, traceId: job.trace_id }),
    normalize: normalizeTriageOutput,
  });
  if (outcome.kind === "stopped") return;
  if (outcome.kind === "retry") {
    await retryItem(deps, claim, outcome.retryAfterMs);
    return;
  }
  if (outcome.kind === "exhausted") {
    await advanceItem(deps, claim, "failed_analysis");
    return;
  }
  const output = readOutput(outcome.row, TriageAssessmentSchema);
  if (output === null) {
    await advanceItem(deps, claim, "failed_analysis");
    return;
  }
  if (output.decision === "reject") {
    await advanceItem(deps, claim, "triaged_reject", {
      attempts: await rejectionCount(deps, item),
    });
    return;
  }
  await passToDeep(deps, claim, job);
}

// A `score` submission is judged against the desk's focus rather than for engineering depth. The
// review is stored with the item on a pass and a reject alike, in the transition that moves it,
// so the dashboard can always show why.
async function reviewSubmission(
  deps: TriageDependencies,
  claim: ItemClaim,
  job: TriageJob,
): Promise<void> {
  const { item } = claim;
  const lang = deps.config.profile.output_lang;
  const outcome = await runAnalysis(deps, claim, {
    key: {
      ...executionKey(item.id, "triage", itemSnapshotHash(item), lang),
      prompt_version: SUBMISSION_REVIEW_PROMPT_VERSION,
    },
    inputSchema: reviewInputSchema,
    prepare: async () => {
      const notes = await readRevision(deps, item);
      const maxChars = Math.min(MAX_EXCERPT_CHARS, deps.config.ai.triage_batch_input_tokens * 3);
      return {
        title: item.title,
        sourceUrl: item.url,
        sourceName: item.score_json?.kind === "submission" ? item.score_json.source_name : null,
        excerpt: notes?.slice(0, maxChars) ?? null,
        topics: deps.config.profile.topics,
        lang,
      };
    },
    prompt: (input) => renderSubmissionReviewPrompt({ ...input, traceId: job.trace_id }),
    normalize: normalizeSubmissionReviewOutput,
  });
  if (outcome.kind === "stopped") return;
  if (outcome.kind === "retry") {
    await retryItem(deps, claim, outcome.retryAfterMs);
    return;
  }
  const output =
    outcome.kind === "completed" ? readOutput(outcome.row, SubmissionReviewOutputSchema) : null;
  if (output === null) {
    await advanceItem(deps, claim, "failed_analysis");
    return;
  }
  if (item.score_json?.kind !== "submission") throw new AppError("ROW_INVALID");
  const at = deps.clock.now();
  const review: SubmissionReview = {
    decision: output.score >= deps.config.push.submission.min_review_score ? "pass" : "reject",
    score: output.score,
    comment: output.comment,
    reviewed_at: at,
  };
  const scoreJson: ItemScore = { ...item.score_json, review };
  if (review.decision === "reject") {
    await advanceItem(deps, claim, "triaged_reject", {
      at,
      attempts: await rejectionCount(deps, item),
      scoreJson,
    });
    return;
  }
  await passToDeep(deps, claim, job, { at, scoreJson });
}

async function passToDeep(
  deps: TriageDependencies,
  claim: ItemClaim,
  job: TriageJob,
  options: { at?: number; scoreJson?: ItemScore } = {},
): Promise<void> {
  const ready = await advanceItem(deps, claim, "triaged_pass", options);
  if (ready) {
    await deps.jobs.enqueue({ v: 1, type: "deep", item_id: claim.item.id, trace_id: job.trace_id });
  }
}

function triageKey(item: Item): ReturnType<typeof executionKey> {
  return executionKey(item.id, "triage", itemSnapshotHash(item));
}

async function rejectionCount(deps: TriageDependencies, item: Item): Promise<number> {
  if (item.revision > 1) {
    const revisions = await deps.revisions.listByItem(item.id);
    for (let index = Math.min(item.revision - 1, revisions.length) - 1; index >= 0; index--) {
      const previous = revisions[index];
      if (previous === undefined || previous.content_hash === item.content_hash) continue;
      const snapshot = { ...item, content_hash: previous.content_hash, revision: index + 1 };
      if (await wasRejected(deps, triageKey(snapshot))) return 2;
    }
  }
  return 1;
}

async function wasRejected(
  deps: TriageDependencies,
  key: ReturnType<typeof executionKey>,
): Promise<boolean> {
  const row = await deps.analyses.findByKey(key);
  return row !== null && readOutput(row, TriageAssessmentSchema)?.decision === "reject";
}

import { TriageAssessmentSchema } from "@ai-moves/contracts/analysis";
import {
  changelogSiteTriageBudgetScope,
  changelogTriageBudgetScope,
  type Item,
} from "@ai-moves/contracts/entities";
import type { TriageJob } from "@ai-moves/contracts/messages";
import type { JobBus } from "@ai-moves/contracts/ports/runtime";
import type { BudgetRequest, SourceRepo } from "@ai-moves/contracts/ports/storage";
import { HEAT_LEVELS, ItemKindSchema, type HeatLevel } from "@ai-moves/contracts/states";
import { stableKey } from "@ai-moves/core/idempotency";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { normalizeTriageOutput, renderTriagePrompt } from "@ai-moves/prompts/triage";
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
} from "./work.ts";

const inputSchema = z.strictObject({
  kind: ItemKindSchema,
  title: z.string(),
  excerpt: z.string().nullable(),
  topics: z.array(z.string()),
});
const MAX_EXCERPT_CHARS = 12_000;

export interface TriageDependencies
  extends AnalysisDependencies, Omit<RevisionEvidenceDependencies, "blobs"> {
  readonly jobs: Pick<JobBus, "enqueue">;
  readonly sources: Pick<SourceRepo, "get">;
}

export async function processTriage(deps: TriageDependencies, job: TriageJob): Promise<void> {
  const item = await deps.items.get(job.item_id);
  if (item === null) return;
  const claim = await claimItem(deps, item, "triage");
  if (claim === null) return;
  const outcome = await runAnalysis(deps, claim, {
    key: triageKey(item, item.tier),
    additionalBudget: () => changelogBudget(deps, item),
    inputSchema,
    prepare: async () => {
      const notes = item.kind === "changelog" ? await readRevision(deps, item) : null;
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
    await advanceItem(
      deps,
      claim,
      outcome.row.error_code === "BUDGET_EXHAUSTED" ? "skipped_budget" : "failed_analysis",
    );
    return;
  }
  if (output.decision === "reject") {
    await advanceItem(deps, claim, "triaged_reject", {
      attempts: await rejectionCount(deps, item),
    });
    return;
  }
  const ready = await advanceItem(deps, claim, "triaged_pass");
  if (ready) {
    await deps.jobs.enqueue({ v: 1, type: "deep", item_id: item.id, trace_id: job.trace_id });
  }
}

async function changelogBudget(
  deps: TriageDependencies,
  item: Item,
): Promise<Pick<BudgetRequest, "scope" | "limit"> | null> {
  if (item.kind !== "changelog") return null;
  const source = await deps.sources.get(item.source_id);
  const origin = source?.config_json;
  if (origin === undefined || origin.kind === "hn_top") throw new AppError("ROW_INVALID");
  try {
    return {
      scope:
        origin.kind === "github_repo"
          ? changelogTriageBudgetScope({ owner: origin.owner, repo: origin.repo })
          : changelogSiteTriageBudgetScope(new URL(origin.page_url).hostname),
      limit: deps.config.changelog.max_triage_per_repo_per_day,
    };
  } catch (cause) {
    throw new AppError("ROW_INVALID", { cause });
  }
}

function triageKey(item: Item, tier: HeatLevel | null): ReturnType<typeof executionKey> {
  const input = itemSnapshotHash(item);
  return executionKey(item.id, "triage", item.kind === "hn" ? stableKey(input, tier ?? "") : input);
}

async function rejectionCount(deps: TriageDependencies, item: Item): Promise<number> {
  if (item.kind === "hn") {
    for (const tier of [null, ...HEAT_LEVELS]) {
      if (tier === item.tier) break;
      if (await wasRejected(deps, triageKey(item, tier))) return 2;
    }
  } else if (item.revision > 1) {
    const revisions = await deps.revisions.listByItem(item.id);
    for (let index = Math.min(item.revision - 1, revisions.length) - 1; index >= 0; index--) {
      const previous = revisions[index];
      if (previous === undefined || previous.content_hash === item.content_hash) continue;
      const snapshot = { ...item, content_hash: previous.content_hash, revision: index + 1 };
      if (await wasRejected(deps, triageKey(snapshot, null))) return 2;
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

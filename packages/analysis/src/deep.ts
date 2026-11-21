import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import {
  ChangelogDeepAssessmentSchema,
  HnDeepAssessmentSchema,
} from "@ai-moves/contracts/analysis";
import type { Analysis, Item, Source } from "@ai-moves/contracts/entities";
import type { DeepJob } from "@ai-moves/contracts/messages";
import type {
  AlertRepo,
  DestinationRepo,
  ItemSnapshotRepo,
  SourceRepo,
} from "@ai-moves/contracts/ports/storage";
import { LANGS } from "@ai-moves/contracts/primitives";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { publicLink } from "@ai-moves/kernel/public-links";
import { renderDeepPrompt } from "@ai-moves/prompts/deep";

import { collectEvidence, DeepInputSchema, type EvidenceDependencies } from "./evidence.ts";
import { draftAlert, type FinalizeAlert } from "./finalization.ts";
import { readTranslation, translateDocument } from "./translation.ts";
import {
  advanceItem,
  claimItem,
  executionKey,
  itemSnapshotHash,
  readAnalysisInput,
  readOutput,
  retryItem,
  runAnalysis,
  type AnalysisDependencies,
  type ItemClaim,
} from "./work.ts";

export interface DeepDependencies
  extends AnalysisDependencies, Omit<EvidenceDependencies, "blobs"> {
  readonly sources: Pick<SourceRepo, "get">;
  readonly snapshots: Pick<ItemSnapshotRepo, "listSince">;
  readonly alerts: Pick<AlertRepo, "getByKey">;
  readonly destinations: Pick<DestinationRepo, "list">;
  readonly detailUrl: (itemId: string) => string;
  readonly finalize: FinalizeAlert;
}

export async function processDeep(deps: DeepDependencies, job: DeepJob): Promise<void> {
  const item = await deps.items.get(job.item_id);
  if (item === null || (item.state !== "triaged_pass" && item.state !== "analyzed")) return;
  const key = executionKey(item.id, "deep", itemSnapshotHash(item));
  if (item.state === "analyzed") {
    const row = await deps.analyses.findByKey(key);
    if (row === null || row.status === "pending") throw new AppError("ROW_INVALID");
    await prepareAndFinalize(deps, job, item, await requireSource(deps, item), row, null);
    return;
  }

  if (!(await deepGateOpen(deps, item))) return;

  const claim = await claimItem(deps, item, "deep");
  if (claim === null) return;
  const source = await requireSource(deps, item);
  const outcome = await runAnalysis(deps, claim, {
    key,
    inputSchema: DeepInputSchema,
    prepare: () =>
      collectEvidence(
        deps,
        item,
        source,
        deps.config.profile.topics,
        deps.config.ai.deep_input_tokens,
      ),
    prompt: ({ title, topics, evidence, blocked }) => {
      if (blocked) throw new AppError("SSRF_BLOCKED");
      const publicEvidence = evidence.flatMap(({ locator, text }) =>
        publicLink(locator) === locator ? [{ locator, text }] : [],
      );
      if (publicEvidence.length === 0) throw new AppError("CONTENT_UNSUPPORTED");
      return renderDeepPrompt({
        traceId: job.trace_id,
        kind: item.kind,
        title,
        topics,
        evidence: publicEvidence,
      });
    },
    normalize: (assessment) => assessment,
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
  await prepareAndFinalize(deps, job, item, source, outcome.row, claim);
}

async function prepareAndFinalize(
  deps: DeepDependencies,
  job: DeepJob,
  item: Item,
  source: Source,
  row: Analysis,
  claim: ItemClaim | null,
): Promise<void> {
  const input = await readAnalysisInput(deps.blobs, row, DeepInputSchema);
  const assessment =
    item.kind === "hn"
      ? readOutput(row, HnDeepAssessmentSchema)
      : readOutput(row, ChangelogDeepAssessmentSchema);
  const draft = await draftAlert({ ...deps, item, row, input, assessment });
  const documents: AlertDoc[] = [];
  if (draft?.english !== null && draft?.english !== undefined) {
    documents.push(draft.english);
    if (claim === null) {
      for (const lang of LANGS) {
        if (lang === "en") continue;
        const document = await readTranslation(deps, item.id, row.id, draft.english, lang);
        if (document !== null) documents.push(document);
      }
    } else if (draft.alert.decision === "send") {
      const destinations = await deps.destinations.list();
      const languages = new Set(
        destinations
          .filter(
            (destination) =>
              destination.enabled &&
              destination.purpose === "alerts" &&
              destination.min_tier <= draft.alert.tier &&
              destination.source_filters[item.kind],
          )
          .map(({ lang }) => lang),
      );
      for (const lang of LANGS) {
        if (lang === "en" || !languages.has(lang)) continue;
        const translated = await translateDocument(
          deps,
          claim,
          row.id,
          draft.english,
          lang,
          job.trace_id,
        );
        if (translated.kind === "stopped") return;
        if (translated.kind === "retry") {
          await retryItem(deps, claim, translated.retryAfterMs);
          return;
        }
        if (translated.document !== null) documents.push(translated.document);
      }
    }
  }

  // Analyzed is a durable wake-up for finalization; replay may read results but cannot call models.
  let analyzed = item;
  if (claim !== null) {
    const at = deps.clock.now();
    if (!(await advanceItem(deps, claim, "analyzed", { at }))) return;
    analyzed = { ...claim.item, state: "analyzed", state_updated_at: at, attempts: 0 };
  }
  const canonical =
    draft === null
      ? null
      : await deps.finalize({
          alert: draft.alert,
          documents,
          item: analyzed,
          source,
          traceId: job.trace_id,
          config: deps.config,
        });
  if (canonical !== null && canonical.alert_key !== draft?.alert.alert_key) {
    throw new AppError("STATE_CONFLICT", {
      message: "Finalization returned a different alert key",
    });
  }
  await deps.items.transition({
    id: item.id,
    from: "analyzed",
    to:
      canonical?.item_id === item.id &&
      canonical.analysis_id === row.id &&
      canonical.decision === "send"
        ? "alerted"
        : "feed_only",
    expected: analyzed,
    at: deps.clock.now(),
  });
}

async function requireSource(deps: DeepDependencies, item: Item): Promise<Source> {
  const source = await deps.sources.get(item.source_id);
  if (source === null) throw new AppError("ROW_INVALID");
  return source;
}

async function deepGateOpen(deps: DeepDependencies, item: Item): Promise<boolean> {
  if (item.kind !== "hn" || item.attempts > 0) return true;
  const gate = deps.config.hn.deep_gate;
  if (deps.clock.now() >= item.state_updated_at + gate.max_wait_minutes * 60_000) return true;
  if (item.score_json?.kind === "hn" && item.score_json.features.comments >= gate.min_comments) {
    return true;
  }
  const latest = (await deps.snapshots.listSince(item.id, item.state_updated_at)).at(-1);
  return latest !== undefined && latest.comments >= gate.min_comments;
}

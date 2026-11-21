import { AlertDocSchema, type AlertDoc } from "@ai-moves/contracts/alert-doc";
import type { ChangelogDeepAssessment, HnDeepAssessment } from "@ai-moves/contracts/analysis";
import type { AppConfig } from "@ai-moves/contracts/config";
import {
  AlertSchema,
  type Alert,
  type Analysis,
  type Item,
  type Source,
} from "@ai-moves/contracts/entities";
import type { AlertRepo } from "@ai-moves/contracts/ports/storage";
import type { TraceId } from "@ai-moves/contracts/primitives";
import type { AlertBlockReason, AlertKind } from "@ai-moves/contracts/states";
import { alertKey } from "@ai-moves/core/idempotency";
import { decideAlert, type AlertDecision } from "@ai-moves/core/policy/delivery";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import {
  hasPublicLinkText,
  linkMentions,
  publicAlertLinks,
  publicLink,
  withoutLinkPunctuation,
} from "@ai-moves/kernel/public-links";

import { verifyCitations, type DeepInput } from "./evidence.ts";

type Assessment = HnDeepAssessment | ChangelogDeepAssessment;

export interface FinalizationRequest {
  readonly alert: Alert;
  readonly documents: readonly AlertDoc[];
  readonly item: Item;
  readonly source: Source;
  readonly traceId: TraceId;
  readonly config: AppConfig;
}

export type FinalizeAlert = (request: FinalizationRequest) => Promise<Alert>;

interface AlertDraft {
  readonly alert: Alert;
  readonly english: AlertDoc | null;
}

interface DraftInput {
  readonly alerts: Pick<AlertRepo, "getByKey">;
  readonly item: Item;
  readonly row: Analysis;
  readonly input: DeepInput;
  readonly assessment: Assessment | null;
  readonly config: AppConfig;
  readonly detailUrl: (itemId: string) => string;
}

export async function draftAlert({
  alerts,
  item,
  row,
  input,
  assessment,
  config,
  detailUrl,
}: DraftInput): Promise<AlertDraft | null> {
  const clusterId = item.cluster_id ?? item.id;
  const original = await alerts.getByKey(alertKey(clusterId, "new"));
  if (original !== null && original.item_id !== item.id) return null;
  const kind: AlertKind = original === null || original.analysis_id === row.id ? "new" : "update";
  const key = alertKey(clusterId, kind);
  const existing = kind === "new" ? original : await alerts.getByKey(key);
  if (existing !== null && existing.analysis_id !== row.id) return null;

  const links = publicAlertLinks({
    source: input.sourceUrl,
    discussion: input.discussion,
    detail: detailUrl(item.id),
  });
  const verified =
    links === null || assessment === null || !hasKnownLinks(assessment, input, links)
      ? null
      : verifyCitations(input.evidence, assessment.citations);
  const citations =
    verified !== null &&
    hasPublicLinkText(input.title) &&
    verified.every(({ quote }) => hasPublicLinkText(quote))
      ? verified
      : null;
  const reason: AlertBlockReason =
    row.error_code === "BUDGET_EXHAUSTED" ? "budget_exhausted" : "citation_check_failed";
  const decision: AlertDecision =
    assessment !== null && input.score !== null
      ? decideAlert({
          assessment,
          score: input.score,
          citationsValid: citations !== null,
          suspectedInjection: false,
          duplicateCluster: false,
          muted: false,
          budgetExhausted: false,
          quietHours: false,
          config: config.push,
        })
      : {
          decision: "feed_only",
          tier: 1,
          blockedBy: [assessment === null ? reason : "below_tier"],
        };

  const alert =
    existing ??
    AlertSchema.parse({
      id: key,
      alert_key: key,
      item_id: item.id,
      analysis_id: row.id,
      cluster_id: clusterId,
      tier: decision.tier,
      kind,
      decision: decision.decision,
      decision_reason_json: {
        why_now:
          assessment !== null && hasPublicLinkText(assessment.why_now)
            ? assessment.why_now
            : "No verified analysis is available.",
        blocked_by: decision.blockedBy,
        importance: assessment?.kind === "hn" ? assessment.importance : null,
        impact: assessment?.kind === "changelog" ? assessment.impact : null,
        heat_level: input.score?.kind === "hn" ? input.score.level : null,
        prior: input.score?.kind === "changelog" ? input.score.prior : null,
      },
      created_at: row.updated_at,
    });
  if (citations === null || assessment === null || links === null) return { alert, english: null };
  const english = AlertDocSchema.safeParse({
    v: 1,
    alert_id: alert.id,
    kind: alert.kind,
    item_kind: item.kind,
    tier: alert.tier,
    lang: "en",
    source_label: input.sourceLabel,
    title: { original: input.title, translated: null },
    why_now: assessment.why_now,
    summary: assessment.summary,
    key_points: [
      ...assessment.key_points.slice(0, 8 - citations.length).map((text) => ({
        text,
        evidence_quote: null,
        comment_id: null,
      })),
      ...citations.map(({ quote, commentId }) => ({
        text: "Source evidence",
        evidence_quote: quote,
        comment_id: commentId,
      })),
    ],
    engineering_implications: assessment.engineering_implications,
    caveats: assessment.caveats,
    links,
    translation: { machine_translated: false, fell_back_to_english: false },
    generated_at: row.updated_at,
  });
  if (!english.success)
    throw new AppError("CONFIG_INVALID", { message: "Invalid alert document identity or URL" });
  return { alert, english: english.data };
}

function hasKnownLinks(
  assessment: Assessment,
  input: DeepInput,
  links: AlertDoc["links"],
): boolean {
  const known = new Set([
    links.source,
    links.discussion,
    ...input.evidence.map(({ locator }) => publicLink(locator)),
  ]);
  const prose = [
    assessment.why_now,
    assessment.summary,
    ...assessment.key_points,
    ...assessment.engineering_implications,
    ...assessment.caveats,
  ];
  return prose.every((text) => {
    for (const [url] of linkMentions(text)) {
      if (!known.has(url) && !known.has(withoutLinkPunctuation(url))) return false;
    }
    return true;
  });
}

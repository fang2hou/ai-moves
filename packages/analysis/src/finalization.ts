import { AlertDocSchema, type AlertDoc } from "@ai-news-tracker/contracts/alert-doc";
import type { CommunityView, DeepAssessment } from "@ai-news-tracker/contracts/analysis";
import type { AppConfig } from "@ai-news-tracker/contracts/config";
import {
  AlertSchema,
  type Alert,
  type Analysis,
  type Item,
  type Source,
} from "@ai-news-tracker/contracts/entities";
import type { AlertRepo } from "@ai-news-tracker/contracts/ports/storage";
import type { TraceId } from "@ai-news-tracker/contracts/primitives";
import type { AlertKind } from "@ai-news-tracker/contracts/states";
import { alertKey } from "@ai-news-tracker/core/idempotency";
import { decideAlert, type AlertDecision } from "@ai-news-tracker/core/policy/delivery";
import { AppError } from "@ai-news-tracker/kernel/errors/app-error";
import {
  hasPublicLinkText,
  linkMentions,
  publicAlertLinks,
  publicLink,
  withoutLinkPunctuation,
} from "@ai-news-tracker/kernel/public-links";
import { allCitationPrefixes } from "@ai-news-tracker/locales/registry";

import { verifyCitations, type DeepInput } from "./evidence.ts";

type Assessment = DeepAssessment;

const MAX_POINTS = 6;
const MAX_QUOTES = 4;

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
  readonly document: AlertDoc | null;
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
  // A new HN or changelog reading replaces the published alert's documents in place; only a
  // forced submission is pushed again, as an `update` keyed by the revision it was forced at.
  const kind: AlertKind =
    item.kind !== "submission" || original === null || original.analysis_id === row.id
      ? "new"
      : "update";
  const key =
    kind === "update" ? alertKey(clusterId, kind, item.revision) : alertKey(clusterId, kind);
  const existing = kind === "new" ? original : await alerts.getByKey(key);
  if (kind === "update" && existing !== null && existing.analysis_id !== row.id) return null;

  const links = publicAlertLinks({
    source: input.sourceUrl,
    discussion: input.discussion,
    detail: detailUrl(item.id),
  });
  // A document is withheld only when a link in its prose cannot be published.
  // Quotes that fail verification are dropped from the page; that they failed
  // still counts against the reading when deciding whether to notify.
  const audit =
    links === null || assessment === null || !hasKnownLinks(assessment, input, links)
      ? null
      : verifyCitations(input.evidence, assessment.citations);
  const citations =
    audit !== null &&
    hasPublicLinkText(input.title) &&
    audit.verified.every(({ quote }) => hasPublicLinkText(quote))
      ? audit.verified
      : null;
  // A rejected quote means the model wrote something the evidence does not say, and
  // that blocks the send. Citing nothing does not: a card carries the reading, not
  // the quotes, so there is no unverified text on it either way.
  const citationsValid = audit !== null && audit.rejected === 0;
  const decision: AlertDecision =
    assessment !== null && input.score !== null
      ? decideAlert({
          assessment,
          score: input.score,
          citationsValid: citations !== null && citationsValid,
          suspectedInjection: false,
          duplicateCluster: false,
          muted: false,
          quietHours: false,
          config: config.push,
        })
      : {
          decision: "feed_only",
          tier: 1,
          blockedBy: [assessment === null ? "citation_check_failed" : "below_tier"],
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
        importance:
          assessment?.kind === "hn" || assessment?.kind === "submission"
            ? assessment.importance
            : null,
        impact: assessment?.kind === "changelog" ? assessment.impact : null,
        heat_level: input.score?.kind === "hn" ? input.score.level : null,
      },
      created_at: row.updated_at,
    });
  if (citations === null || assessment === null || links === null) return { alert, document: null };
  const summary = cleanModelText(assessment.summary);
  const points = assessment.key_points.flatMap((point) => {
    const text = cleanModelText(point.text);
    return text === null
      ? []
      : [
          {
            category: "category" in point ? point.category : null,
            text,
            implication: point.implication === null ? null : cleanModelText(point.implication),
            evidence_quote: null,
            comment_id: null,
          },
        ];
  });
  if (summary === null || points.length === 0) return { alert, document: null };
  const document = AlertDocSchema.safeParse({
    v: 1,
    alert_id: alert.id,
    kind: alert.kind,
    item_kind: item.kind,
    tier: alert.tier,
    lang: config.profile.output_lang,
    source_label: input.sourceLabel,
    // The headline is the card's title, so it is cleaned like the rest. One with
    // nothing readable left is no headline, and the source title stands in for it.
    title: {
      original: input.title,
      translated: assessment.headline === null ? null : cleanModelText(assessment.headline),
    },
    summary,
    key_points: [
      ...points.slice(0, MAX_POINTS),
      ...citations.slice(0, MAX_QUOTES).map(({ quote, commentId }) => ({
        category: null,
        text: quote,
        implication: null,
        evidence_quote: quote,
        comment_id: commentId,
      })),
    ],
    community_view: cleanCommunityView(assessment.community_view),
    links,
    translation: { machine_translated: false, fell_back_to_english: false },
    // Only the display name is public; the submitter's email stays in score_json.
    submitted_by: input.score?.kind === "submission" ? input.score.submitter.name : null,
    generated_at: row.updated_at,
  });
  if (!document.success)
    throw new AppError("CONFIG_INVALID", { message: "Invalid alert document identity or URL" });
  return { alert, document: document.data };
}

// A string field that ends in the JSON punctuation which should have closed it, or
// that holds nothing but the name of the next schema field, is a structured-output
// slip rather than a reading. Neither reaches a page.
const JSON_TAIL = /\s*[{}[\]]+[\s,.;:{}[\]"']*$/u;
const SCHEMA_TOKEN = /^[a-z][a-z\d]*(?:_[a-z\d]+)*$/u;
const HAS_WORD = /[\p{L}\p{N}]/u;
// Citations belong in the citations field and links are the program's to write, so a
// model that appends either to its prose has it taken back off. The marker and
// everything after it goes, which is where these always land.
const citationPrefixes = allCitationPrefixes()
  .map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
  .join("|");
const CITATION_TAIL = new RegExp(
  String.raw`[\s(（【[]*(?<![\p{L}\p{N}_])(?:${citationPrefixes})\s*[:：].*$`,
  "iu",
);
const BARE_URL = /\s*(?:<\s*)?https?:\/\/\S+/giu;
// A footnote marker the writing never asks for: [1], [^2], [citation:3], 【4】.
// A bracket that follows a word is an index in code, as in a[0], and is left alone.
const MARKER =
  /(?:(?<=^|[\s。，、；：！？.,;:!?)\]])\[\s*(?:\^|cit(?:ation)?\s*[:：]?\s*|ref\s*[:：]?\s*)?\d{1,3}\s*\]|【\s*\d{1,3}\s*】)/giu;

// A model that loses its place repeats a short phrase until it runs out of room.
// The result parses and reads as prose, so the only tell is how little of it is
// distinct: real writing of this length barely repeats an eight-character window.
const WINDOW = 8;
const MIN_LENGTH = 80;
const MIN_VARIETY = 0.75;

function degenerate(text: string): boolean {
  const total = text.length - WINDOW + 1;
  if (text.length < MIN_LENGTH || total <= 0) return false;
  const windows = new Set<string>();
  for (let index = 0; index < total; index++) {
    windows.add(text.slice(index, index + WINDOW));
  }
  return windows.size / total < MIN_VARIETY;
}

export function cleanModelText(input: string): string | null {
  // The marker goes first: stripped of its closing bracket by the JSON tail, a marker
  // that ends the field would be left behind as "[1".
  const text = input
    .replace(MARKER, "")
    .replace(JSON_TAIL, "")
    .replace(CITATION_TAIL, "")
    .replace(BARE_URL, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return !HAS_WORD.test(text) || SCHEMA_TOKEN.test(text) || degenerate(text) ? null : text;
}

function cleanCommunityView(view: CommunityView | null): CommunityView | null {
  if (view === null) return null;
  const summary = cleanModelText(view.summary);
  if (summary === null) return null;
  return {
    overall: view.overall,
    summary,
    supporting: view.supporting.flatMap((text) => cleanModelText(text) ?? []),
    opposing: view.opposing.flatMap((text) => cleanModelText(text) ?? []),
  };
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
    ...assessment.key_points.flatMap(({ text, implication }) =>
      implication === null ? [text] : [text, implication],
    ),
    ...(assessment.community_view === null
      ? []
      : [
          assessment.community_view.summary,
          ...assessment.community_view.supporting,
          ...assessment.community_view.opposing,
        ]),
  ];
  return prose.every((text) => {
    for (const [url] of linkMentions(text)) {
      if (!known.has(url) && !known.has(withoutLinkPunctuation(url))) return false;
    }
    return true;
  });
}

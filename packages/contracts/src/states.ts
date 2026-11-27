import { z } from "zod";

// `submission` is the one source row every submitted item belongs to; it is never polled.
export const SOURCE_KINDS = ["hn_top", "github_repo", "web_page", "submission"] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SOURCE_STATUSES = ["active", "degraded", "disabled"] as const;
export const SourceStatusSchema = z.enum(SOURCE_STATUSES);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const GITHUB_REPO_STRATEGIES = [
  "release_first",
  "changelog_file",
  "tags_plus_changelog",
] as const;
export const GitHubRepoStrategySchema = z.enum(GITHUB_REPO_STRATEGIES);
export type GitHubRepoStrategy = z.infer<typeof GitHubRepoStrategySchema>;

// A submission is markdown a signed-in reader sent through the MCP endpoint.
export const ITEM_KINDS = ["hn", "changelog", "submission"] as const;
export const ItemKindSchema = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const ITEM_STATES = [
  "discovered",
  "tracking",
  "candidate",
  "skipped_trivial",
  "triaging",
  "triaged_reject",
  "triaged_pass",
  "skipped_budget", // Legacy read-only state for historical items.
  "analyzing",
  "analyzed",
  "failed_analysis",
  "alerted",
  "feed_only",
  "archived",
] as const;
export const ItemStateSchema = z.enum(ITEM_STATES);
export type ItemState = z.infer<typeof ItemStateSchema>;

// Edges of the state diagram in architecture 4.3, plus the three edges section 4.5 needs but the
// diagram omits: a sweeper releasing an expired lease (`triaging -> candidate`,
// `analyzing -> triaged_pass`) and triage retries running out (`triaging -> failed_analysis`).
export const ITEM_STATE_TRANSITIONS = {
  discovered: ["tracking", "triaged_pass", "candidate", "skipped_trivial"],
  tracking: ["triaged_pass", "candidate", "archived"],
  candidate: ["triaging"],
  skipped_trivial: [],
  triaging: ["triaged_reject", "triaged_pass", "candidate", "failed_analysis"],
  // A reader may force a rejected or failed submission straight to deep analysis.
  triaged_reject: ["candidate", "triaged_pass"],
  triaged_pass: ["analyzing"],
  skipped_budget: [],
  // An exhausted refresh restores the item's published state.
  analyzing: ["analyzed", "failed_analysis", "triaged_pass", "alerted", "feed_only"],
  analyzed: ["alerted", "feed_only"],
  failed_analysis: ["triaged_pass"],
  // Published HN stories re-enter deep analysis for living-document refreshes.
  alerted: ["candidate", "triaged_pass", "archived"],
  feed_only: ["triaged_pass", "archived"],
  archived: [],
} as const satisfies Record<ItemState, readonly ItemState[]>;

export const ITEM_TERMINAL_STATES: readonly ItemState[] = ITEM_STATES.filter(
  (state) => ITEM_STATE_TRANSITIONS[state].length === 0,
);

export function isItemTransitionAllowed(from: ItemState, to: ItemState): boolean {
  const targets: readonly ItemState[] = ITEM_STATE_TRANSITIONS[from];
  return targets.includes(to);
}

export function isItemStateTerminal(state: ItemState): boolean {
  return ITEM_TERMINAL_STATES.includes(state);
}

export const LEASED_STAGES = ["triage", "deep", "deliver"] as const;
export const LeasedStageSchema = z.enum(LEASED_STAGES);
export type LeasedStage = z.infer<typeof LeasedStageSchema>;

export const ITEM_LEASED_STATES = {
  triaging: "triage",
  analyzing: "deep",
} as const satisfies Partial<Record<ItemState, LeasedStage>>;

export const HEAT_LEVELS = ["H1", "H2", "H3"] as const;
export const HeatLevelSchema = z.enum(HEAT_LEVELS);
export type HeatLevel = z.infer<typeof HeatLevelSchema>;

export const HN_GATES = ["G1", "G2", "G3"] as const;
export const HnGateSchema = z.enum(HN_GATES);
export type HnGate = z.infer<typeof HnGateSchema>;

export const REVISION_ORIGINS = ["release", "tag", "changelog_file", "submission"] as const;
export const RevisionOriginSchema = z.enum(REVISION_ORIGINS);
export type RevisionOrigin = z.infer<typeof RevisionOriginSchema>;

export const ANALYSIS_STAGES = ["triage", "deep", "polish", "translate"] as const;
export const AnalysisStageSchema = z.enum(ANALYSIS_STAGES);
export type AnalysisStage = z.infer<typeof AnalysisStageSchema>;

export const ANALYSIS_STATUSES = ["pending", "succeeded", "failed"] as const;
export const AnalysisStatusSchema = z.enum(ANALYSIS_STATUSES);
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;

export const ALERT_KINDS = ["new", "update"] as const;
export const AlertKindSchema = z.enum(ALERT_KINDS);
export type AlertKind = z.infer<typeof AlertKindSchema>;

export const ALERT_DECISIONS = ["send", "feed_only"] as const;
export const AlertDecisionSchema = z.enum(ALERT_DECISIONS);
export type AlertDecision = z.infer<typeof AlertDecisionSchema>;

export const ALERT_BLOCK_REASONS = [
  "below_tier",
  "citation_check_failed",
  "suspected_injection",
  "muted",
  "budget_exhausted", // Legacy read-only reason for historical alerts.
  "quiet_hours",
  "duplicate_cluster",
  "rollout_feed_only",
] as const;
export const AlertBlockReasonSchema = z.enum(ALERT_BLOCK_REASONS);
export type AlertBlockReason = z.infer<typeof AlertBlockReasonSchema>;

// 1 is the lowest grade that may be pushed and 3 the highest. How importance, impact, and heat map
// onto a tier is push policy and belongs to `core`.
export const ALERT_TIERS = [1, 2, 3] as const;
export const AlertTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type AlertTier = z.infer<typeof AlertTierSchema>;

export const DESTINATION_CHANNELS = ["slack", "discord"] as const;
export const DestinationChannelSchema = z.enum(DESTINATION_CHANNELS);
export type DestinationChannel = z.infer<typeof DestinationChannelSchema>;

export const DESTINATION_PURPOSES = ["alerts", "ops"] as const;
export const DestinationPurposeSchema = z.enum(DESTINATION_PURPOSES);
export type DestinationPurpose = z.infer<typeof DestinationPurposeSchema>;

export const DELIVERY_STATES = [
  "pending",
  "sending",
  "sent",
  "failed_retryable",
  "failed_permanent",
  "unknown",
  "expired",
  "suppressed",
] as const;
export const DeliveryStateSchema = z.enum(DELIVERY_STATES);
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

// Architecture 4.4. A `sending` row whose lease expired has an unknowable outcome, so the only
// way out of it without a provider response is `unknown`. The two self-transitions record a
// deferral: the row keeps its state and moves `next_attempt_at` (and `expires_at`) later.
export const DELIVERY_STATE_TRANSITIONS = {
  pending: ["pending", "sending", "expired", "suppressed"],
  sending: ["sent", "failed_retryable", "failed_permanent", "unknown"],
  sent: [],
  failed_retryable: ["failed_retryable", "sending", "failed_permanent", "expired", "suppressed"],
  failed_permanent: [],
  unknown: [],
  expired: [],
  suppressed: [],
} as const satisfies Record<DeliveryState, readonly DeliveryState[]>;

export const DELIVERY_TERMINAL_STATES: readonly DeliveryState[] = DELIVERY_STATES.filter(
  (state) => DELIVERY_STATE_TRANSITIONS[state].length === 0,
);

export function isDeliveryTransitionAllowed(from: DeliveryState, to: DeliveryState): boolean {
  const targets: readonly DeliveryState[] = DELIVERY_STATE_TRANSITIONS[from];
  return targets.includes(to);
}

export function isDeliveryStateTerminal(state: DeliveryState): boolean {
  return DELIVERY_TERMINAL_STATES.includes(state);
}

export const DELIVERY_SUPPRESSION_REASONS = [
  "budget", // Legacy read-only reason for historical deliveries.
  "quiet_hours", // Legacy read-only: quiet hours now defer a delivery rather than suppress it.
  "mute",
  "destination_disabled",
  "global_pause",
  "below_tier",
  "source_disabled",
  "rate_limit", // Legacy read-only: the send interval now defers a delivery rather than suppress it.
  "update_limit",
  "unverified_content",
  "rollout_feed_only",
] as const;
export const DeliverySuppressionReasonSchema = z.enum(DELIVERY_SUPPRESSION_REASONS);
export type DeliverySuppressionReason = z.infer<typeof DeliverySuppressionReasonSchema>;

export const PIPELINE_STAGES = [
  "tick",
  "poll",
  "triage",
  "deep",
  "polish",
  "translate",
  "deliver",
  "sweep",
  "api",
] as const;
export const PipelineStageSchema = z.enum(PIPELINE_STAGES);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

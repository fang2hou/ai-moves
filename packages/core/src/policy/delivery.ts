import type { ChangelogDeepAssessment, HnDeepAssessment } from "@ai-moves/contracts/analysis";
import type { AppConfig } from "@ai-moves/contracts/config";
import type { ChangelogScore, HnScore } from "@ai-moves/contracts/scoring";
import type {
  AlertBlockReason,
  AlertTier,
  DeliverySuppressionReason,
  ItemKind,
} from "@ai-moves/contracts/states";

const tierFromScore = (level: HnScore["level"], impact: number | null): AlertTier => {
  if (impact !== null) return impact >= 3 ? 3 : impact >= 2 ? 2 : 1;
  if (level === "H3") return 3;
  if (level === "H2") return 2;
  return 1;
};

export interface DecideAlertInput {
  readonly assessment: HnDeepAssessment | ChangelogDeepAssessment;
  readonly score: HnScore | ChangelogScore;
  readonly citationsValid: boolean;
  readonly suspectedInjection: boolean;
  readonly duplicateCluster: boolean;
  readonly muted: boolean;
  readonly budgetExhausted: boolean;
  readonly quietHours: boolean;
  readonly config: AppConfig["push"];
}

export interface AlertDecision {
  readonly decision: "send" | "feed_only";
  readonly tier: AlertTier;
  readonly blockedBy: readonly AlertBlockReason[];
}

function pushThresholdPasses(input: DecideAlertInput): boolean {
  if (input.assessment.kind === "hn" && input.score.kind === "hn") {
    const { hn } = input.config;
    return (
      input.assessment.importance >= hn.min_importance ||
      (input.assessment.importance >= hn.borderline_importance &&
        input.score.level !== null &&
        input.score.level >= hn.borderline_min_heat_level)
    );
  }
  if (input.assessment.kind === "changelog" && input.score.kind === "changelog") {
    const { changelog } = input.config;
    return (
      input.assessment.impact >= changelog.min_impact ||
      (input.assessment.impact >= changelog.borderline_impact &&
        input.score.prior >= changelog.borderline_min_prior)
    );
  }
  return false;
}

export function decideAlert(input: DecideAlertInput): AlertDecision {
  const tier =
    input.score.kind === "hn"
      ? tierFromScore(input.score.level, null)
      : tierFromScore(null, input.assessment.kind === "changelog" ? input.assessment.impact : null);
  const blockedBy: AlertBlockReason[] = [];
  if (!pushThresholdPasses(input)) blockedBy.push("below_tier");
  if (!input.citationsValid) blockedBy.push("citation_check_failed");
  if (input.suspectedInjection) blockedBy.push("suspected_injection");
  if (input.muted) blockedBy.push("muted");
  if (input.budgetExhausted) blockedBy.push("budget_exhausted");
  if (input.quietHours) blockedBy.push("quiet_hours");
  if (input.duplicateCluster) blockedBy.push("duplicate_cluster");
  return { decision: blockedBy.length === 0 ? "send" : "feed_only", tier, blockedBy };
}

export interface DecideDeliveryInput {
  readonly itemKind: ItemKind;
  readonly itemTier: AlertTier;
  readonly destination: {
    readonly enabled: boolean;
    readonly minTier: AlertTier;
    readonly dailyBudget: number;
    readonly usedToday: number;
    readonly sourceAllowed: boolean;
    readonly muted: boolean;
  };
  readonly global: {
    readonly paused: boolean;
    readonly quietHours: boolean;
    readonly sourceUsedToday: number;
    readonly minutesSincePrevious: number | null;
  };
  readonly config: AppConfig["delivery"];
  readonly expiresAt: number;
  readonly now: number;
  readonly isUpdate: boolean;
  readonly updatesSent: number;
}

export type DeliveryPolicyDecision =
  | { readonly action: "send"; readonly reason: null }
  | { readonly action: "expire"; readonly reason: "expired" }
  | { readonly action: "suppress"; readonly reason: DeliverySuppressionReason };

export function decideDelivery(input: DecideDeliveryInput): DeliveryPolicyDecision {
  if (input.now >= input.expiresAt) return { action: "expire", reason: "expired" };
  if (input.global.paused) return { action: "suppress", reason: "global_pause" };
  if (!input.destination.enabled) return { action: "suppress", reason: "destination_disabled" };
  if (input.destination.muted) return { action: "suppress", reason: "mute" };
  if (input.destination.usedToday >= input.destination.dailyBudget) {
    return { action: "suppress", reason: "budget" };
  }
  if (input.global.sourceUsedToday >= input.config.daily_cap_per_source[input.itemKind]) {
    return { action: "suppress", reason: "budget" };
  }
  if (input.global.quietHours) return { action: "suppress", reason: "quiet_hours" };
  if (!input.destination.sourceAllowed) return { action: "suppress", reason: "source_disabled" };
  if (input.itemTier < input.destination.minTier)
    return { action: "suppress", reason: "below_tier" };
  if (input.isUpdate && input.updatesSent >= input.config.max_updates_per_item) {
    return { action: "suppress", reason: "update_limit" };
  }
  if (
    input.global.minutesSincePrevious !== null &&
    input.global.minutesSincePrevious < input.config.min_interval_minutes
  ) {
    return { action: "suppress", reason: "rate_limit" };
  }
  return { action: "send", reason: null };
}

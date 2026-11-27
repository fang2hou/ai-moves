import type { DeepAssessment } from "@ai-moves/contracts/analysis";
import type { AppConfig } from "@ai-moves/contracts/config";
import type { QuietHours } from "@ai-moves/contracts/entities";
import type { HnScore, ItemScore } from "@ai-moves/contracts/scoring";
import type {
  AlertBlockReason,
  AlertTier,
  DeliverySuppressionReason,
} from "@ai-moves/contracts/states";

const tierFromScore = (level: HnScore["level"], impact: number | null): AlertTier => {
  if (impact !== null) return impact >= 3 ? 3 : impact >= 2 ? 2 : 1;
  if (level === "H3") return 3;
  if (level === "H2") return 2;
  return 1;
};

const tierFromImportance = (importance: number): AlertTier =>
  importance >= 4 ? 3 : importance === 3 ? 2 : 1;

export interface DecideAlertInput {
  readonly assessment: DeepAssessment;
  readonly score: ItemScore;
  readonly citationsValid: boolean;
  readonly suspectedInjection: boolean;
  readonly duplicateCluster: boolean;
  readonly muted: boolean;
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
  if (input.assessment.kind === "submission" && input.score.kind === "submission") {
    // A reader who chose `publish` has already decided; only `score` is held to a bar.
    return (
      input.score.mode === "publish" ||
      input.assessment.importance >= input.config.submission.min_importance
    );
  }
  return false;
}

export function decideAlert(input: DecideAlertInput): AlertDecision {
  const tier =
    input.score.kind === "hn"
      ? tierFromScore(input.score.level, null)
      : input.assessment.kind === "submission"
        ? tierFromImportance(input.assessment.importance)
        : tierFromScore(
            null,
            input.assessment.kind === "changelog" ? input.assessment.impact : null,
          );
  const blockedBy: AlertBlockReason[] = [];
  if (!pushThresholdPasses(input)) blockedBy.push("below_tier");
  if (!input.citationsValid) blockedBy.push("citation_check_failed");
  if (input.suspectedInjection) blockedBy.push("suspected_injection");
  if (input.muted) blockedBy.push("muted");
  if (input.quietHours) blockedBy.push("quiet_hours");
  if (input.duplicateCluster) blockedBy.push("duplicate_cluster");
  return { decision: blockedBy.length === 0 ? "send" : "feed_only", tier, blockedBy };
}

export interface DecideDeliveryInput {
  readonly itemTier: AlertTier;
  readonly destination: {
    readonly enabled: boolean;
    readonly minTier: AlertTier;
    readonly sourceAllowed: boolean;
    readonly muted: boolean;
  };
  readonly global: {
    readonly paused: boolean;
    // The quiet windows that apply to this delivery: the global one and the destination's own.
    readonly quietWindows: readonly QuietHours[];
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
  | { readonly action: "defer"; readonly until: number }
  | { readonly action: "suppress"; readonly reason: DeliverySuppressionReason };

// Pacing between sends is not decided here: it depends on what was sent, so storage settles it
// atomically with the claim (`DeliveryRepo.claimForSend`).
export function decideDelivery(input: DecideDeliveryInput): DeliveryPolicyDecision {
  if (input.now >= input.expiresAt) return { action: "expire", reason: "expired" };
  if (input.global.paused) return { action: "suppress", reason: "global_pause" };
  if (!input.destination.enabled) return { action: "suppress", reason: "destination_disabled" };
  if (input.destination.muted) return { action: "suppress", reason: "mute" };
  if (!input.destination.sourceAllowed) return { action: "suppress", reason: "source_disabled" };
  if (input.itemTier < input.destination.minTier)
    return { action: "suppress", reason: "below_tier" };
  if (input.isUpdate && input.updatesSent >= input.config.max_updates_per_item) {
    return { action: "suppress", reason: "update_limit" };
  }
  // After every suppression, so a delivery that will never be sent is not held overnight first.
  const until = quietReleaseAt(input.now, input.global.quietWindows);
  if (until > input.now) return { action: "defer", until };
  return { action: "send", reason: null };
}

function minutesOfDay(at: number, timeZone: string): number {
  let hour = 0;
  let minute = 0;
  for (const part of new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at)) {
    if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  return hour * 60 + minute;
}

function parseTimeOfDay(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;

// `start` is inside the window and `end` is not; a window with `start > end` crosses midnight
// and one with `start === end` is empty.
function isQuiet(at: number, hours: QuietHours): boolean {
  const now = minutesOfDay(at, hours.timezone);
  const start = parseTimeOfDay(hours.start);
  const end = parseTimeOfDay(hours.end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

// The first instant at or after `at` that lies outside every window, or `at` itself when it
// already does. The end of one window can fall inside another, so this follows the chain; the
// bound only matters for windows that together cover the whole day.
export function quietReleaseAt(at: number, windows: readonly QuietHours[]): number {
  let release = at;
  for (let round = 0; round <= windows.length * 2; round += 1) {
    const active = windows.filter((hours) => isQuiet(release, hours));
    if (active.length === 0) return release;
    release = Math.max(...active.map((hours) => windowEnd(release, hours)));
  }
  return release;
}

// The instant the window containing `at` ends, on whole minutes. Stepping by the minutes left
// in the day and then correcting against the zone keeps this right across a UTC-offset change.
function windowEnd(at: number, hours: QuietHours): number {
  const end = parseTimeOfDay(hours.end);
  const minutesLeft = (end - minutesOfDay(at, hours.timezone) + DAY_MINUTES) % DAY_MINUTES;
  const minuteStart = at - (((at % MINUTE_MS) + MINUTE_MS) % MINUTE_MS);
  let candidate = minuteStart + (minutesLeft === 0 ? DAY_MINUTES : minutesLeft) * MINUTE_MS;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const drift = minutesOfDay(candidate, hours.timezone) - end;
    if (drift === 0) break;
    // Fold the difference into [-12 h, 12 h) so the correction moves the short way round.
    candidate -= (((drift + DAY_MINUTES * 1.5) % DAY_MINUTES) - DAY_MINUTES / 2) * MINUTE_MS;
  }
  return candidate;
}

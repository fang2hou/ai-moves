import type { CommunityView, PointCategory } from "@ai-moves/contracts/analysis";
import type { Lang } from "@ai-moves/contracts/primitives";
import type { AlertBlockReason } from "@ai-moves/contracts/states";

export type DeskErrorCode = "UNAVAILABLE" | "INVALID_RESPONSE" | "NOT_FOUND" | "INVALID_LINK";

export interface PromptLocale {
  readonly writingRules: readonly string[];
  readonly citationPrefixes: readonly string[];
  readonly polishCitationExample: string;
}

export interface DeliveryLocale {
  readonly sourceLabel: string;
  readonly pointsLabel: string;
  readonly readingLabel: string;
  readonly detailButtonLabel: string;
  readonly sourceButtonLabel: string;
  readonly discussionButtonLabel: string;
  readonly submittedByLabel: string;
  readonly groupLabels: Readonly<Record<PointCategory, string>>;
}

export type HeatRange = 7 | 30;

export interface HeatLocale {
  readonly title: string;
  readonly rangeAriaLabel: string;
  readonly ranges: Readonly<Record<HeatRange, string>>;
  readonly published: string;
  readonly discussions: string;
  readonly releases: string;
  readonly submissions: string;
  readonly peak: string;
  readonly daily: string;
  readonly sources: string;
  readonly hottest: string;
  readonly empty: string;
  readonly partial: string;
  readonly formatCount: (count: number) => string;
  readonly formatPoints: (count: number) => string;
  readonly formatComments: (count: number) => string;
  readonly formatDayTooltip: (
    day: string,
    discussions: number,
    releases: number,
    submissions: number,
  ) => string;
}

// What a reader sees for the problems the submissions page can hit; `SIGN_IN` is a 401 or a
// non-JSON reply, which is how an unauthenticated request to the MCP endpoint looks.
export type SubmissionsErrorCode = "SIGN_IN" | "UNAVAILABLE" | "INVALID_RESPONSE" | "REJECTED";

// One badge per row, derived from the item's state, alert outcome, and `forced_by`.
export type SubmissionBadge = "in_review" | "rejected" | "published" | "sent" | "failed" | "forced";

export interface SubmissionsLocale {
  readonly title: string;
  readonly empty: string;
  readonly submittedBy: string;
  readonly awaitingReview: string;
  readonly notReviewed: string;
  readonly decisions: Readonly<Record<"pass" | "reject", string>>;
  readonly badges: Readonly<Record<SubmissionBadge, string>>;
  readonly deliveryStatus: Readonly<Record<"sent" | "in_flight" | "unconfirmed" | "held", string>>;
  readonly formatAlertNotSent: (reasons: readonly string[]) => string;
  readonly blockReasons: Readonly<Record<AlertBlockReason, string>>;
  readonly forcedBy: string;
  readonly force: string;
  readonly forcing: string;
  readonly formatConfirmForce: (title: string) => string;
  readonly rereview: string;
  readonly rereviewing: string;
  readonly formatConfirmRereview: (title: string) => string;
  readonly errors: Readonly<Record<SubmissionsErrorCode, string>>;
}

export interface DeskLocale {
  readonly siteName: string;
  readonly siteDescription: string;
  readonly titleSeparator: string;
  readonly skipToContent: string;
  readonly navAriaLabel: string;
  readonly navLatest: string;
  readonly navHeat: string;
  readonly navSubmissions: string;
  readonly heat: HeatLocale;
  readonly submissions: SubmissionsLocale;
  readonly loading: string;
  readonly footer: string;
  readonly backHome: string;
  readonly backArrow: string;
  readonly olderItems: string;
  readonly noOlderItems: string;
  readonly noItemsYet: string;
  readonly noDocument: string;
  readonly pointsHeading: string;
  readonly communityHeading: string;
  readonly supportingHeading: string;
  readonly opposingHeading: string;
  readonly aiInsightTag: string;
  readonly readSource: string;
  readonly hnDiscussion: string;
  readonly submittedBy: string;
  readonly moods: Readonly<Record<CommunityView["overall"], string>>;
  readonly categories: Readonly<Record<PointCategory, string>>;
  readonly errors: Readonly<Record<DeskErrorCode, string>>;
}

export interface LocalePack {
  readonly lang: Lang;
  readonly englishName: string;
  readonly dateLocale: string;
  readonly prompt: PromptLocale;
  readonly delivery: DeliveryLocale;
  readonly desk: DeskLocale;
}

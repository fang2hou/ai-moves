import type { CommunityView, PointCategory } from "@ai-moves/contracts/analysis";
import type { Lang } from "@ai-moves/contracts/primitives";

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
  readonly groupLabels: Readonly<Record<PointCategory, string>>;
}

export interface DeskLocale {
  readonly siteName: string;
  readonly siteDescription: string;
  readonly skipToContent: string;
  readonly navAriaLabel: string;
  readonly navLatest: string;
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

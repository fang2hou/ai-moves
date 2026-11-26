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

export type HeatRange = 7 | 30;

export interface HeatLocale {
  readonly title: string;
  readonly ranges: Readonly<Record<HeatRange, string>>;
  readonly published: string;
  readonly discussions: string;
  readonly releases: string;
  readonly peak: string;
  readonly daily: string;
  readonly sources: string;
  readonly hottest: string;
  readonly points: string;
  readonly comments: string;
  readonly empty: string;
  readonly partial: string;
}

export interface DeskLocale {
  readonly siteName: string;
  readonly siteDescription: string;
  readonly skipToContent: string;
  readonly navAriaLabel: string;
  readonly navLatest: string;
  readonly navHeat: string;
  readonly heat: HeatLocale;
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

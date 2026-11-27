import { z } from "zod";

import { EpochMsSchema, NonNegativeIntSchema, UnitIntervalSchema } from "./primitives.ts";
import { HeatLevelSchema, HnGateSchema } from "./states.ts";

// Architecture 6.1. Velocities are per hour over the sampling window.
export const HnFeaturesSchema = z.object({
  vp: z.number(),
  vc: z.number(),
  acc: z.number(),
  climb: z.number(),
  points: NonNegativeIntSchema,
  comments: NonNegativeIntSchema,
  rank: z.int().positive().nullable(),
  age_h: z.number().nonnegative(),
});
export type HnFeatures = z.infer<typeof HnFeaturesSchema>;

// Each feature scaled into 0..1 against the configured reference rate.
export const HnPercentilesSchema = z.object({
  vp: UnitIntervalSchema,
  vc: UnitIntervalSchema,
  climb: UnitIntervalSchema,
  acc: UnitIntervalSchema,
  points: UnitIntervalSchema,
});
export type HnPercentiles = z.infer<typeof HnPercentilesSchema>;

// How close a story is to AI-assisted software engineering, judged once by a model from its
// title and link: `core` for mainstream AI models and mainstream agent harnesses or AI coding
// tools; `adjacent` for other AI or software engineering; `unrelated` for everything else.
export const HN_RELEVANCE = ["core", "adjacent", "unrelated"] as const;
export const HnRelevanceSchema = z.enum(HN_RELEVANCE);
export type HnRelevance = z.infer<typeof HnRelevanceSchema>;

export const HnScoreSchema = z.object({
  kind: z.literal("hn"),
  // Weighted by relevance: the raw activity heat times the relevance weight, capped at 100.
  heat: z.number().min(0).max(100),
  level: HeatLevelSchema.nullable(),
  features: HnFeaturesSchema,
  percentiles: HnPercentilesSchema,
  gates: z.array(HnGateSchema),
  // Null until the story has been judged; an unjudged story is weighted as `adjacent`.
  relevance: HnRelevanceSchema.nullable().default(null),
  // Counts sampled after publication while the story stays ranked. The qualifying score above is
  // left as it was, so analysis inputs keyed on it do not change.
  latest: z
    .object({
      points: NonNegativeIntSchema,
      comments: NonNegativeIntSchema,
      sampled_at: EpochMsSchema,
    })
    .nullable()
    .default(null),
  computed_at: EpochMsSchema,
});
export type HnScore = z.infer<typeof HnScoreSchema>;

export const CHANGELOG_SIGNALS = [
  "new_surface",
  "breaking",
  "default_change",
  "long_notes",
  "semver_minor_or_major",
  "fix_or_deps_only",
  "prerelease",
] as const;
export const ChangelogSignalSchema = z.enum(CHANGELOG_SIGNALS);
export type ChangelogSignal = z.infer<typeof ChangelogSignalSchema>;

export const ChangelogSignalHitSchema = z.object({
  signal: ChangelogSignalSchema,
  points: z.int(),
  evidence: z.array(z.string().max(500)),
});
export type ChangelogSignalHit = z.infer<typeof ChangelogSignalHitSchema>;

// Architecture 6.2.
export const ChangelogScoreSchema = z.object({
  kind: z.literal("changelog"),
  prior: z.number().min(0).max(100),
  signals: z.array(ChangelogSignalHitSchema),
  computed_at: EpochMsSchema,
});
export type ChangelogScore = z.infer<typeof ChangelogScoreSchema>;

// Who sent a submission, from the identity the platform verified. The name is published with the
// item; the email never leaves storage.
export const SubmitterSchema = z.object({
  name: z.string().trim().min(1).max(64),
  email: z.email().max(254).nullable(),
});
export type Submitter = z.infer<typeof SubmitterSchema>;

// `score` asks the triage model whether the submission is worth analyzing and sends the card only
// above the importance threshold; `publish` skips both, leaving only the normal delivery checks.
export const SUBMISSION_MODES = ["score", "publish"] as const;
export const SubmissionModeSchema = z.enum(SUBMISSION_MODES);
export type SubmissionMode = z.infer<typeof SubmissionModeSchema>;

export const SubmissionScoreSchema = z.object({
  kind: z.literal("submission"),
  mode: SubmissionModeSchema,
  submitter: SubmitterSchema,
  // Who published the source, as the submitter named them; the card's source line falls back to
  // the URL's host.
  source_name: z.string().min(1).max(100).nullable().default(null),
  computed_at: EpochMsSchema,
});
export type SubmissionScore = z.infer<typeof SubmissionScoreSchema>;

export const ItemScoreSchema = z.discriminatedUnion("kind", [
  HnScoreSchema,
  ChangelogScoreSchema,
  SubmissionScoreSchema,
]);
export type ItemScore = z.infer<typeof ItemScoreSchema>;

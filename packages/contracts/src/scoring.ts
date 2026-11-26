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
// title and link: `core` for coding agents, harnesses, and coding models; `adjacent` for AI or
// software engineering at large; `unrelated` for everything else.
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

export const ItemScoreSchema = z.discriminatedUnion("kind", [HnScoreSchema, ChangelogScoreSchema]);
export type ItemScore = z.infer<typeof ItemScoreSchema>;

import type { AppConfig } from "@ai-moves/contracts/config";
import type { HnFeatures, HnPercentiles, HnScore } from "@ai-moves/contracts/scoring";
import type { HeatLevel, HnGate } from "@ai-moves/contracts/states";

export interface HnGateHistory {
  readonly heat: readonly number[];
  readonly ranks: readonly (number | null)[];
}

export interface ScoreHnInput {
  readonly features: HnFeatures;
  readonly percentiles: HnPercentiles | null;
  readonly history: HnGateHistory;
  readonly config: AppConfig["hn"];
  readonly computedAt: number;
}

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));

export function coldStartPercentiles(
  features: HnFeatures,
  config: AppConfig["hn"]["cold_start"],
): HnPercentiles {
  return {
    vp: clampUnit(features.vp / config.vp_per_hour),
    vc: clampUnit(features.vc / config.vc_per_hour),
    climb: 0,
    acc: 0,
    points: 0,
  };
}

export function computeHnHeat(
  features: HnFeatures,
  percentiles: HnPercentiles | null,
  config: AppConfig["hn"],
): number {
  const distribution = percentiles ?? coldStartPercentiles(features, config.cold_start);
  const weighted =
    distribution.vp * config.heat_weights.vp +
    distribution.vc * config.heat_weights.vc +
    distribution.climb * config.heat_weights.climb +
    distribution.acc * config.heat_weights.acc +
    distribution.points * config.heat_weights.points;
  return Math.max(0, Math.min(100, weighted * 100));
}

export function heatLevel(heat: number, config: AppConfig["hn"]["heat_levels"]): HeatLevel | null {
  if (heat >= config.h3) return "H3";
  if (heat >= config.h2) return "H2";
  if (heat >= config.h1) return "H1";
  return null;
}

function consecutiveAtLeast(values: readonly number[], threshold: number): number {
  let count = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value === undefined || value < threshold) break;
    count += 1;
  }
  return count;
}

function computeGates(
  input: ScoreHnInput,
  score: number,
  level: HeatLevel | null,
): readonly HnGate[] {
  const gates: HnGate[] = [];
  const { config, features, history, percentiles } = input;
  const burstHeatHistory = [...history.heat, score];
  const burst =
    features.age_h <= config.gate_burst.max_age_hours &&
    features.points >= config.gate_burst.min_points &&
    (score >= config.gate_burst.single_sample_heat ||
      (level !== null &&
        consecutiveAtLeast(burstHeatHistory, config.gate_burst.heat) >=
          config.gate_burst.consecutive_samples));
  if (burst) gates.push("G1");

  const discussion =
    percentiles !== null &&
    percentiles.vc >= config.gate_discussion.vc_percentile &&
    features.comments >= config.gate_discussion.min_comments;
  if (discussion) gates.push("G2");

  const ranks = [...history.ranks, features.rank];
  let sustainedCount = 0;
  for (let index = ranks.length - 1; index >= 0; index -= 1) {
    const rank = ranks[index];
    if (rank === undefined || rank === null || rank > config.gate_sustained.max_rank) break;
    sustainedCount += 1;
  }
  if (sustainedCount >= config.gate_sustained.consecutive_samples) gates.push("G3");
  return gates;
}

export function scoreHn(input: ScoreHnInput): HnScore {
  const heat = computeHnHeat(input.features, input.percentiles, input.config);
  const level = heatLevel(heat, input.config.heat_levels);
  return {
    kind: "hn",
    heat,
    level,
    features: input.features,
    percentiles: input.percentiles,
    gates: [...computeGates(input, heat, level)],
    cold_start: input.percentiles === null,
    computed_at: input.computedAt,
  };
}

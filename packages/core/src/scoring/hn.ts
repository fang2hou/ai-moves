import type { AppConfig } from "@ai-moves/contracts/config";
import type { HnFeatures, HnPercentiles, HnRelevance, HnScore } from "@ai-moves/contracts/scoring";
import type { HeatLevel, HnGate } from "@ai-moves/contracts/states";

export interface HnGateHistory {
  readonly heat: readonly number[];
  readonly ranks: readonly (number | null)[];
}

export interface ScoreHnInput {
  readonly features: HnFeatures;
  // Heats of earlier samples, already weighted by the same relevance.
  readonly history: HnGateHistory;
  // Already scaled by activity; scoring weighs it by relevance.
  readonly config: AppConfig["hn"];
  readonly relevance: HnRelevance | null;
  readonly computedAt: number;
}

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));

export function computeHnActivity(
  vps: readonly number[],
  config: AppConfig["hn"]["activity"],
): number {
  if (vps.length < config.min_samples) return 1;
  const sorted = vps.toSorted((left, right) => left - right);
  const p75 = sorted[Math.floor(0.75 * (sorted.length - 1))] ?? config.baseline_vp_per_hour;
  return Math.max(
    config.min_factor,
    Math.min(config.max_factor, p75 / config.baseline_vp_per_hour),
  );
}

function scaleFloor(base: number, factor: number): number {
  return base === 0 ? 0 : Math.max(1, Math.round(base * factor));
}

export function scaleHnConfig(config: AppConfig["hn"], activity: number): AppConfig["hn"] {
  const { reference, gate_burst, gate_discussion, gate_sustained } = config;
  return {
    ...config,
    reference: {
      vp_per_hour: reference.vp_per_hour * activity,
      vc_per_hour: reference.vc_per_hour * activity,
      climb_per_window: reference.climb_per_window,
      acc_per_hour: reference.acc_per_hour * activity,
      points: reference.points * activity,
    },
    gate_burst: { ...gate_burst, min_points: scaleFloor(gate_burst.min_points, activity) },
    gate_discussion: {
      ...gate_discussion,
      min_comments: scaleFloor(gate_discussion.min_comments, activity),
    },
    gate_sustained: {
      ...gate_sustained,
      min_points: scaleFloor(gate_sustained.min_points, activity),
    },
  };
}

export function normalizeFeatures(
  features: HnFeatures,
  config: AppConfig["hn"]["reference"],
): HnPercentiles {
  return {
    vp: clampUnit(features.vp / config.vp_per_hour),
    vc: clampUnit(features.vc / config.vc_per_hour),
    climb: clampUnit(features.climb / config.climb_per_window),
    acc: clampUnit(features.acc / config.acc_per_hour),
    points: clampUnit(features.points / config.points),
  };
}

export function relevanceWeight(
  relevance: HnRelevance | null,
  config: AppConfig["hn"]["relevance"],
): number {
  if (relevance === "core") return config.core_weight;
  if (relevance === "unrelated") return config.unrelated_weight;
  return 1;
}

// A heavier story clears the volume floors sooner and a lighter one later; heat thresholds stay
// fixed because the heat itself carries the weight.
function weighHnConfig(config: AppConfig["hn"], weight: number): AppConfig["hn"] {
  const { gate_burst, gate_discussion, gate_sustained } = config;
  return {
    ...config,
    gate_burst: { ...gate_burst, min_points: scaleFloor(gate_burst.min_points, 1 / weight) },
    gate_discussion: {
      ...gate_discussion,
      min_comments: scaleFloor(gate_discussion.min_comments, 1 / weight),
    },
    gate_sustained: {
      ...gate_sustained,
      min_points: scaleFloor(gate_sustained.min_points, 1 / weight),
    },
  };
}

export function computeHnHeat(
  features: HnFeatures,
  config: AppConfig["hn"],
  weight: number,
): number {
  const distribution = normalizeFeatures(features, config.reference);
  const weighted =
    distribution.vp * config.heat_weights.vp +
    distribution.vc * config.heat_weights.vc +
    distribution.climb * config.heat_weights.climb +
    distribution.acc * config.heat_weights.acc +
    distribution.points * config.heat_weights.points;
  return Math.max(0, Math.min(100, weighted * 100 * weight));
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
  percentiles: HnPercentiles,
): readonly HnGate[] {
  const gates: HnGate[] = [];
  const { config, features, history } = input;
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
  if (
    sustainedCount >= config.gate_sustained.consecutive_samples &&
    features.points >= config.gate_sustained.min_points &&
    features.age_h <= config.gate_sustained.max_age_hours
  )
    gates.push("G3");
  return gates;
}

export function scoreHn(input: ScoreHnInput): HnScore {
  const weight = relevanceWeight(input.relevance, input.config.relevance);
  const config = weighHnConfig(input.config, weight);
  const percentiles = normalizeFeatures(input.features, config.reference);
  const heat = computeHnHeat(input.features, config, weight);
  const level = heatLevel(heat, config.heat_levels);
  return {
    kind: "hn",
    heat,
    level,
    features: input.features,
    percentiles,
    gates: [...computeGates({ ...input, config }, heat, level, percentiles)],
    relevance: input.relevance,
    latest: null,
    computed_at: input.computedAt,
  };
}

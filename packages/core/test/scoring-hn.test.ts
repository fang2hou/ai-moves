import { describe, expect, it } from "vitest";

import { AppConfigSchema } from "@ai-moves/contracts/config";
import type { HnFeatures, HnPercentiles } from "@ai-moves/contracts/scoring";

import { coldStartPercentiles, computeHnHeat, heatLevel, scoreHn } from "../src/scoring/hn.ts";

const config = AppConfigSchema.parse({
  models: {
    triage: { provider: "test", model: "triage", max_output_tokens: 1 },
    deep: { provider: "test", model: "deep", max_output_tokens: 1 },
    translate: { provider: "test", model: "translate", max_output_tokens: 1 },
  },
}).hn;
const features: HnFeatures = {
  vp: 60,
  vc: 40,
  acc: 1,
  climb: 1,
  points: 20,
  comments: 30,
  rank: 10,
  age_h: 24,
};
const percentiles: HnPercentiles = { vp: 1, vc: 1, climb: 1, acc: 1, points: 1 };

describe("HN scoring", () => {
  it("computes the configured weighted score and cold-start fallback deterministically", () => {
    expect(computeHnHeat(features, percentiles, config)).toBe(100);
    expect(coldStartPercentiles(features, config.cold_start)).toEqual({
      vp: 1,
      vc: 1,
      climb: 0,
      acc: 0,
      points: 0,
    });
    expect(computeHnHeat(features, null, config)).toBe(60);
  });

  it.each([
    [69.999, null],
    [70, "H1"],
    [84.999, "H1"],
    [85, "H2"],
    [94.999, "H2"],
    [95, "H3"],
    [100, "H3"],
  ] as const)("maps heat %s to %s", (heat, expected) => {
    expect(heatLevel(heat, config.heat_levels)).toBe(expected);
  });

  it("requires all configured burst boundaries", () => {
    expect(
      scoreHn({
        features,
        percentiles: { ...percentiles, vp: 0.35, vc: 0.25 },
        history: { heat: [], ranks: [] },
        config,
        computedAt: 1,
      }).gates,
    ).toEqual([]);
    expect(
      scoreHn({
        features,
        percentiles,
        history: { heat: [70], ranks: [] },
        config,
        computedAt: 1,
      }).gates,
    ).toContain("G1");
    expect(
      scoreHn({
        features: { ...features, age_h: 24.001 },
        percentiles,
        history: { heat: [], ranks: [] },
        config,
        computedAt: 1,
      }).gates,
    ).not.toContain("G1");
  });

  it("applies discussion and sustained-rank gates only at inclusive boundaries", () => {
    const score = scoreHn({
      features,
      percentiles: { ...percentiles, vc: 0.9 },
      history: { heat: [], ranks: [2, 10] },
      config,
      computedAt: 1,
    });
    expect(score.gates).toEqual(["G1", "G2", "G3"]);
    expect(score.computed_at).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import type { HnDeepAssessment } from "@ai-moves/contracts/analysis";
import { AppConfigSchema } from "@ai-moves/contracts/config";
import type { HnScore } from "@ai-moves/contracts/scoring";

import { decideAlert, decideDelivery, type DecideDeliveryInput } from "../src/policy/delivery.ts";

const config = AppConfigSchema.parse({
  models: {
    triage: { provider: "test", model: "triage", max_output_tokens: 1 },
    deep: { provider: "test", model: "deep", max_output_tokens: 1 },
    translate: { provider: "test", model: "translate", max_output_tokens: 1 },
  },
});
const assessment: HnDeepAssessment = {
  kind: "hn",
  importance: 4,
  confidence: 0.9,
  why_now: "now",
  summary: "summary",
  key_points: [],
  engineering_implications: [],
  caveats: [],
  citations: [],
};
const score: HnScore = {
  kind: "hn",
  heat: 90,
  level: "H2",
  features: { vp: 1, vc: 1, acc: 1, climb: 1, points: 1, comments: 1, rank: 1, age_h: 1 },
  percentiles: null,
  gates: ["G1"],
  cold_start: true,
  computed_at: 1,
};

const deliveryInput: DecideDeliveryInput = {
  itemKind: "hn",
  itemTier: 2,
  destination: {
    enabled: true,
    minTier: 2,
    dailyBudget: 8,
    usedToday: 7,
    sourceAllowed: true,
    muted: false,
  },
  global: {
    paused: false,
    quietHours: false,
    sourceUsedToday: 4,
    minutesSincePrevious: 10,
  },
  config: config.delivery,
  expiresAt: 101,
  now: 100,
  isUpdate: false,
  updatesSent: 0,
};

describe("alert policy", () => {
  it("sends only when deterministic and assessment thresholds pass", () => {
    expect(
      decideAlert({
        assessment,
        score,
        citationsValid: true,
        suspectedInjection: false,
        duplicateCluster: false,
        muted: false,
        budgetExhausted: false,
        quietHours: false,
        config: config.push,
      }),
    ).toEqual({ decision: "send", tier: 2, blockedBy: [] });
  });

  it("reports blocking reasons in stable precedence order", () => {
    expect(
      decideAlert({
        assessment: { ...assessment, importance: 2 },
        score,
        citationsValid: false,
        suspectedInjection: true,
        duplicateCluster: true,
        muted: true,
        budgetExhausted: true,
        quietHours: true,
        config: config.push,
      }).blockedBy,
    ).toEqual([
      "below_tier",
      "citation_check_failed",
      "suspected_injection",
      "muted",
      "budget_exhausted",
      "quiet_hours",
      "duplicate_cluster",
    ]);
  });

  it("keeps borderline importance inclusive at H2", () => {
    expect(
      decideAlert({
        assessment: { ...assessment, importance: 3 },
        score,
        citationsValid: true,
        suspectedInjection: false,
        duplicateCluster: false,
        muted: false,
        budgetExhausted: false,
        quietHours: false,
        config: config.push,
      }).decision,
    ).toBe("send");
  });
});

describe("delivery suppression", () => {
  it("allows exact budget, interval, tier, and expiry boundaries", () => {
    expect(decideDelivery(deliveryInput)).toEqual({ action: "send", reason: null });
    expect(decideDelivery({ ...deliveryInput, now: 101 })).toEqual({
      action: "expire",
      reason: "expired",
    });
  });

  it.each([
    [{ now: 101, global: { ...deliveryInput.global, paused: true } }, "expired"],
    [{ global: { ...deliveryInput.global, paused: true } }, "global_pause"],
    [{ destination: { ...deliveryInput.destination, enabled: false } }, "destination_disabled"],
    [{ destination: { ...deliveryInput.destination, muted: true } }, "mute"],
    [{ destination: { ...deliveryInput.destination, usedToday: 8 } }, "budget"],
    [{ global: { ...deliveryInput.global, sourceUsedToday: 5 } }, "budget"],
    [{ global: { ...deliveryInput.global, quietHours: true } }, "quiet_hours"],
    [{ destination: { ...deliveryInput.destination, sourceAllowed: false } }, "source_disabled"],
    [{ itemTier: 1 }, "below_tier"],
    [{ isUpdate: true, updatesSent: 1 }, "update_limit"],
    [{ global: { ...deliveryInput.global, minutesSincePrevious: 9 } }, "rate_limit"],
  ] as const)("uses the first applicable suppression %#", (patch, reason) => {
    expect(decideDelivery({ ...deliveryInput, ...patch })).toEqual({
      action: reason === "expired" ? "expire" : "suppress",
      reason,
    });
  });
});

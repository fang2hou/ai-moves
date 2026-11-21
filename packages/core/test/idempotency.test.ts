import { describe, expect, it } from "vitest";

import {
  alertKey,
  analysisKey,
  deliveryKey,
  itemKey,
  pollScheduleKey,
  revisionKey,
  stableKey,
} from "../src/idempotency.ts";

const HASH = "a".repeat(64);

describe("idempotency keys", () => {
  it("matches the SHA-256 digest of an unambiguous canonical input", () => {
    expect(stableKey("a", "bc")).toBe(
      "5310a58788781ab25d5ad7c3f85035824b4eb7bdfa394e0ac2186271472b5492",
    );
  });

  it("is stable for duplicates and distinct for every frozen boundary component", () => {
    expect(pollScheduleKey("source", 42)).toBe(pollScheduleKey("source", 42));
    expect(pollScheduleKey("source", 42)).not.toBe(pollScheduleKey("source", 43));
    expect(itemKey("external")).toBe(itemKey("external"));
    expect(revisionKey("item", HASH)).not.toBe(revisionKey("other", HASH));
    expect(
      analysisKey({
        itemId: "item",
        stage: "deep",
        inputHash: HASH,
        promptVersion: "v1",
        lang: "en",
      }),
    ).not.toBe(
      analysisKey({
        itemId: "item",
        stage: "deep",
        inputHash: HASH,
        promptVersion: "v2",
        lang: "en",
      }),
    );
    expect(alertKey("cluster", "new")).not.toBe(alertKey("cluster", "update"));
    expect(deliveryKey("alert", "destination-a")).not.toBe(deliveryKey("alert", "destination-b"));
  });

  it("does not collide delimiter-like component values", () => {
    expect(stableKey("a:b", "c")).not.toBe(stableKey("a", "b:c"));
  });
});

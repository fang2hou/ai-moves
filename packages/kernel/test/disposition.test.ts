import { ERROR_CODES, ERROR_KINDS, type ErrorKind, errorKindOf } from "@ai-moves/contracts/errors";
import { describe, expect, it } from "vitest";

import { AppError } from "../src/errors/app-error.ts";
import {
  decideFailure,
  FAILURE_ACTION_BY_KIND,
  type FailureAction,
  type RetryPolicy,
  retryDelayMs,
} from "../src/errors/disposition.ts";

// The delivery schedule of architecture 4.4: 30 s, 2 min, 10 min, 30 min, at most 5 attempts.
const DELIVER_POLICY: RetryPolicy = { maxAttempts: 5, backoffSeconds: [30, 120, 600, 1800] };

describe("error kind to failure action", () => {
  const expected: readonly (readonly [ErrorKind, FailureAction])[] = [
    ["retryable", "retry"],
    ["permanent", "fail"],
    ["ambiguous", "hold"],
    ["budget", "skip"],
    ["validation", "fail"],
    ["security", "quarantine"],
  ];

  it("covers every kind", () => {
    expect(expected.map(([kind]) => kind).toSorted()).toEqual(ERROR_KINDS.toSorted());
    expect(Object.keys(FAILURE_ACTION_BY_KIND).toSorted()).toEqual(ERROR_KINDS.toSorted());
  });

  it.each(expected)("maps %s to %s", (kind, action) => {
    expect(FAILURE_ACTION_BY_KIND[kind]).toBe(action);
  });

  it.each(ERROR_CODES)("decides the first failure of %s by its kind alone", (code) => {
    const decision = decideFailure(new AppError(code), 1, DELIVER_POLICY);
    expect(decision.action).toBe(FAILURE_ACTION_BY_KIND[errorKindOf(code)]);
  });

  it("never retries an ambiguous outcome, whatever the attempt count", () => {
    for (const attempt of [1, 2, 5, 50]) {
      expect(decideFailure(new AppError("OUTCOME_UNKNOWN"), attempt, DELIVER_POLICY)).toEqual({
        action: "hold",
      });
    }
  });

  it("treats an unclassified error as retryable with bounded attempts", () => {
    expect(decideFailure(new Error("unexpected"), 1, DELIVER_POLICY)).toEqual({
      action: "retry",
      delayMs: 30_000,
    });
    expect(decideFailure(new Error("unexpected"), 5, DELIVER_POLICY)).toEqual({
      action: "fail",
      exhausted: true,
    });
  });

  it("marks a permanent failure as not exhausted", () => {
    expect(decideFailure(new AppError("UPSTREAM_REJECTED"), 1, DELIVER_POLICY)).toEqual({
      action: "fail",
      exhausted: false,
    });
  });
});

describe("retry schedule", () => {
  const schedule: readonly (readonly [number, number | "exhausted"])[] = [
    [1, 30_000],
    [2, 120_000],
    [3, 600_000],
    [4, 1_800_000],
    [5, "exhausted"],
    [6, "exhausted"],
  ];

  it.each(schedule)("after attempt %i the decision is %s", (attempt, expected) => {
    const decision = decideFailure(new AppError("UPSTREAM_UNAVAILABLE"), attempt, DELIVER_POLICY);
    expect(decision).toEqual(
      expected === "exhausted"
        ? { action: "fail", exhausted: true }
        : { action: "retry", delayMs: expected },
    );
  });

  it("lets a provider hint lengthen the wait but not shorten it", () => {
    const longer = new AppError("UPSTREAM_RATE_LIMITED", { retryAfterMs: 90_000 });
    const shorter = new AppError("UPSTREAM_RATE_LIMITED", { retryAfterMs: 1000 });
    expect(decideFailure(longer, 1, DELIVER_POLICY)).toEqual({ action: "retry", delayMs: 90_000 });
    expect(decideFailure(shorter, 1, DELIVER_POLICY)).toEqual({ action: "retry", delayMs: 30_000 });
  });

  it("repeats the last delay and applies the cap", () => {
    const capped: RetryPolicy = {
      maxAttempts: 100,
      backoffSeconds: [600, 7200],
      maxDelaySeconds: 3600,
    };
    expect(retryDelayMs(capped, 1, undefined)).toBe(600_000);
    expect(retryDelayMs(capped, 2, undefined)).toBe(3_600_000);
    expect(retryDelayMs(capped, 40, undefined)).toBe(3_600_000);
    expect(retryDelayMs(capped, 1, 86_400_000)).toBe(3_600_000);
  });

  it("treats a non-positive attempt as the first", () => {
    expect(retryDelayMs(DELIVER_POLICY, 0, undefined)).toBe(30_000);
  });
});

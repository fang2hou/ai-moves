import { describe, expect, it } from "vitest";

import {
  ERROR_CODE_KINDS,
  ERROR_CODES,
  ERROR_KINDS,
  type ErrorCode,
  type ErrorKind,
  errorKindOf,
} from "../src/errors.ts";

describe("error codes", () => {
  it("assigns every code one of the six kinds", () => {
    expect(ERROR_CODES.length).toBe(Object.keys(ERROR_CODE_KINDS).length);
    for (const code of ERROR_CODES) {
      expect(ERROR_KINDS).toContain(errorKindOf(code));
    }
  });

  it("uses every kind at least once", () => {
    const used = new Set(ERROR_CODES.map(errorKindOf));
    expect([...used].toSorted()).toEqual(ERROR_KINDS.toSorted());
  });

  it("uses SCREAMING_SNAKE_CASE codes", () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
    }
  });

  const classifications: readonly (readonly [ErrorCode, ErrorKind])[] = [
    ["UPSTREAM_RATE_LIMITED", "retryable"],
    ["UPSTREAM_UNAVAILABLE", "retryable"],
    ["UPSTREAM_TIMEOUT", "retryable"],
    ["INTERNAL", "retryable"],
    ["UPSTREAM_REJECTED", "permanent"],
    ["STATE_CONFLICT", "permanent"],
    ["OUTCOME_UNKNOWN", "ambiguous"],
    ["BUDGET_EXHAUSTED", "budget"],
    ["MESSAGE_INVALID", "validation"],
    ["LLM_OUTPUT_INVALID", "validation"],
    ["CONFIG_INVALID", "validation"],
    ["SSRF_BLOCKED", "security"],
    ["SUSPECTED_INJECTION", "security"],
  ];

  it.each(classifications)("classifies %s as %s", (code, kind) => {
    expect(errorKindOf(code)).toBe(kind);
  });
});

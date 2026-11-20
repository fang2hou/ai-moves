import { ERROR_CODES, errorKindOf } from "@ai-moves/contracts/errors";
import { describe, expect, it } from "vitest";

import { AppError, isAppError, summarizeError, toAppError } from "../src/errors/app-error.ts";

describe("AppError", () => {
  it.each(ERROR_CODES)("derives the kind of %s from the contract table", (code) => {
    const error = new AppError(code);
    expect(error.kind).toBe(errorKindOf(code));
    expect(error.code).toBe(code);
    expect(error.message).toBe(code);
    expect(error.name).toBe("AppError");
  });

  it("carries message, cause, retry hint, and context", () => {
    const cause = new TypeError("socket closed");
    const error = new AppError("UPSTREAM_RATE_LIMITED", {
      message: "429 from provider",
      cause,
      retryAfterMs: 2000,
      context: { status: 429 },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("429 from provider");
    expect(error.cause).toBe(cause);
    expect(error.retryAfterMs).toBe(2000);
    expect(error.context).toEqual({ status: 429 });
  });

  it("defaults to no retry hint and an empty context", () => {
    const error = new AppError("NOT_FOUND");
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.context).toEqual({});
    expect(error.cause).toBeUndefined();
  });
});

describe("toAppError", () => {
  it("returns an AppError unchanged", () => {
    const error = new AppError("SSRF_BLOCKED");
    expect(toAppError(error)).toBe(error);
  });

  it("classifies an unknown Error as INTERNAL and keeps it as the cause", () => {
    const original = new RangeError("index out of range");
    const error = toAppError(original);
    expect(isAppError(error)).toBe(true);
    expect(error.code).toBe("INTERNAL");
    expect(error.kind).toBe("retryable");
    expect(error.message).toBe("index out of range");
    expect(error.cause).toBe(original);
  });

  it.each([
    ["a string", "boom", "boom"],
    ["undefined", undefined, "Non-error value thrown"],
    ["an object", { reason: "x" }, "Non-error value thrown"],
  ])("wraps %s", (_name, thrown, message) => {
    const error = toAppError(thrown);
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe(message);
  });

  it("uses the fallback code the caller chooses", () => {
    expect(toAppError(new Error("d1 down"), "STORAGE_UNAVAILABLE").code).toBe(
      "STORAGE_UNAVAILABLE",
    );
  });
});

describe("summarizeError", () => {
  it("returns code, kind, and message", () => {
    expect(
      summarizeError(new AppError("BUDGET_EXHAUSTED", { message: "deep budget used" })),
    ).toEqual({ code: "BUDGET_EXHAUSTED", kind: "budget", message: "deep budget used" });
  });

  it("redacts secrets and bounds the message length", () => {
    const leaked = new Error(
      `POST https://hooks.slack.com/services/T000/B000/XXXXXXXX failed ${"x".repeat(1000)}`,
    );
    const summary = summarizeError(leaked);
    expect(summary.message).not.toContain("hooks.slack.com");
    expect(summary.message).toContain("[REDACTED]");
    expect(summary.message.length).toBeLessThanOrEqual(500);
  });
});

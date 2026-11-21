import { DestinationSchema } from "@ai-moves/contracts/entities";
import { JobSchema } from "@ai-moves/contracts/messages";
import { describe, expect, it } from "vitest";

import { parseBoundary, parseJsonBoundary } from "../src/boundary.ts";
import { isAppError } from "../src/errors/app-error.ts";

function capture(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

const job = { v: 1, type: "deep", item_id: "item_1", trace_id: "trace_1" };

describe("parseBoundary", () => {
  it("returns the parsed value", () => {
    expect(parseBoundary(JobSchema, job, "MESSAGE_INVALID")).toEqual(job);
  });

  it("round-trips a queue message through JSON", () => {
    expect(parseJsonBoundary(JobSchema, JSON.stringify(job), "MESSAGE_INVALID")).toEqual(job);
  });

  it("throws a validation error naming the path and the issue", () => {
    const error = capture(() => parseBoundary(JobSchema, { ...job, v: 9 }, "MESSAGE_INVALID"));
    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) {
      return;
    }
    expect(error.code).toBe("MESSAGE_INVALID");
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("v (invalid_value)");
    expect(error.context).toMatchObject({ issues: [{ path: "v", issue: "invalid_value" }] });
  });

  it("merges caller context and reports the root path", () => {
    const error = capture(() =>
      parseBoundary(JobSchema, "nope", "MESSAGE_INVALID", { queue: "q-deep" }),
    );
    expect(isAppError(error) && error.context).toMatchObject({
      queue: "q-deep",
      issues: [{ path: "(root)" }],
    });
  });

  it("never echoes the rejected data", () => {
    const secret = "https://hooks.slack.com/services/T000/B000/SECRETVALUE";
    const error = capture(() =>
      parseBoundary(DestinationSchema, { name: "main", secret_ref: secret }, "ROW_INVALID"),
    );
    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) {
      return;
    }
    expect(`${error.message} ${JSON.stringify(error.context)}`).not.toContain("SECRETVALUE");
    expect(error.message).toContain("secret_ref");
  });

  it("limits the number of reported issues but keeps the total", () => {
    const error = capture(() => parseBoundary(DestinationSchema, {}, "ROW_INVALID"));
    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) {
      return;
    }
    const issues = error.context["issues"];
    expect(Array.isArray(issues) && issues.length).toBe(10);
    expect(error.context["issue_count"]).toBeGreaterThan(10);
  });

  it("rejects text that is not JSON with the same code", () => {
    const error = capture(() => parseJsonBoundary(JobSchema, "{not json", "MESSAGE_INVALID"));
    expect(isAppError(error) && error.code).toBe("MESSAGE_INVALID");
    expect(isAppError(error) && error.message).toContain("not valid JSON");
  });
});

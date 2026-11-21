import { describe, expect, it, vi } from "vitest";

import { AppError } from "../src/errors/app-error.ts";
import { attempt, err, ok } from "../src/result.ts";
import { createConsoleTelemetry } from "../src/telemetry/console.ts";

describe("Result", () => {
  it("wraps values and failures", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err("x")).toEqual({ ok: false, error: "x" });
  });

  it("captures a resolved operation", async () => {
    expect(await attempt(() => Promise.resolve(42))).toEqual({ ok: true, value: 42 });
  });

  it("captures a classified failure without changing it", async () => {
    const failure = new AppError("BUDGET_EXHAUSTED");
    const result = await attempt(() => Promise.reject(failure));
    expect(result).toEqual({ ok: false, error: failure });
  });

  it("classifies an unknown failure", async () => {
    const result = await attempt(() => Promise.reject(new Error("boom")));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("INTERNAL");
  });
});

describe("createConsoleTelemetry", () => {
  it("writes one JSON line per record to the stream matching its level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const telemetry = createConsoleTelemetry();
    const base = { ts: 1, event: "e", component: "c" };

    telemetry.log({ ...base, level: "info" });
    telemetry.log({ ...base, level: "debug" });
    telemetry.log({ ...base, level: "warn" });
    telemetry.log({ ...base, level: "error" });

    expect(log.mock.calls).toEqual([
      [JSON.stringify({ ...base, level: "info" })],
      [JSON.stringify({ ...base, level: "debug" })],
    ]);
    expect(warn.mock.calls).toEqual([[JSON.stringify({ ...base, level: "warn" })]]);
    expect(error.mock.calls).toEqual([[JSON.stringify({ ...base, level: "error" })]]);
  });

  it("writes counters as JSON lines", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const telemetry = createConsoleTelemetry();
    telemetry.count("deliver.sent", 1, { channel: "slack" });
    telemetry.count("tick", 1);
    expect(log.mock.calls).toEqual([
      ['{"metric":"deliver.sent","value":1,"dimensions":{"channel":"slack"}}'],
      ['{"metric":"tick","value":1,"dimensions":{}}'],
    ]);
  });
});

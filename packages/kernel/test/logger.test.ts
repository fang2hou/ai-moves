import { type LogRecord, LogRecordSchema } from "@ai-moves/contracts/logging";
import type { Telemetry } from "@ai-moves/contracts/ports/runtime";
import { describe, expect, it } from "vitest";

import { AppError } from "../src/errors/app-error.ts";
import { createLogger } from "../src/logger.ts";
import { REDACTED } from "../src/redact.ts";

function recorder(): { readonly telemetry: Telemetry; readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    telemetry: { log: (record) => records.push(record), count: () => undefined },
  };
}

const clock = { now: () => 1_795_000_000_000 };

describe("createLogger", () => {
  it("emits the fixed fields and nothing undefined", () => {
    const { telemetry, records } = recorder();
    createLogger({ telemetry, clock, component: "ingestion" }).info("tick.start");
    expect(records).toEqual([
      { ts: 1_795_000_000_000, level: "info", event: "tick.start", component: "ingestion" },
    ]);
    expect(Object.values(records[0] ?? {})).not.toContain(undefined);
  });

  it("produces records that satisfy the contract schema after a JSON round trip", () => {
    const { telemetry, records } = recorder();
    const logger = createLogger({ telemetry, clock, component: "delivery", level: "debug" });
    logger.error("deliver.failed", {
      trace_id: "trace_1",
      source_id: "src_1",
      item_id: "item_1",
      stage: "deliver",
      duration_ms: 12.5,
      err: new AppError("UPSTREAM_RATE_LIMITED", { message: "429" }),
      attrs: { attempt: 2 },
    });
    const wire: unknown = JSON.parse(JSON.stringify(records[0]));
    expect(LogRecordSchema.parse(wire)).toEqual(records[0]);
    expect(records[0]?.err).toEqual({
      code: "UPSTREAM_RATE_LIMITED",
      kind: "retryable",
      message: "429",
    });
  });

  it("drops records below the configured level", () => {
    const { telemetry, records } = recorder();
    const logger = createLogger({ telemetry, clock, component: "core", level: "warn" });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(records.map((record) => record.event)).toEqual(["c", "d"]);
  });

  it("defaults to the info level", () => {
    const { telemetry, records } = recorder();
    const logger = createLogger({ telemetry, clock, component: "core" });
    logger.debug("a");
    logger.info("b");
    expect(records.map((record) => record.level)).toEqual(["info"]);
  });

  it("binds context in child loggers and lets a call override it", () => {
    const { telemetry, records } = recorder();
    const root = createLogger({ telemetry, clock, component: "pipeline" });
    const child = root.child({ component: "analysis", trace_id: "trace_1", stage: "triage" });
    const grandchild = child.child({ item_id: "item_1" });
    grandchild.info("triage.done");
    grandchild.info("deep.start", { stage: "deep" });
    root.info("unrelated");
    expect(records).toEqual([
      {
        ts: 1_795_000_000_000,
        level: "info",
        event: "triage.done",
        component: "analysis",
        trace_id: "trace_1",
        item_id: "item_1",
        stage: "triage",
      },
      {
        ts: 1_795_000_000_000,
        level: "info",
        event: "deep.start",
        component: "analysis",
        trace_id: "trace_1",
        item_id: "item_1",
        stage: "deep",
      },
      { ts: 1_795_000_000_000, level: "info", event: "unrelated", component: "pipeline" },
    ]);
  });

  it("redacts secrets in attributes and in error messages", () => {
    const { telemetry, records } = recorder();
    createLogger({ telemetry, clock, component: "delivery" }).warn("deliver.retry", {
      err: new Error("POST https://hooks.slack.com/services/T000/B000/XXXX timed out"),
      attrs: { webhook_url: "https://hooks.slack.com/services/T000/B000/XXXX", prompt: "p" },
    });
    const line = JSON.stringify(records[0]);
    expect(line).not.toContain("hooks.slack.com");
    expect(records[0]?.attrs).toEqual({ webhook_url: REDACTED, prompt: REDACTED });
    expect(records[0]?.err?.code).toBe("INTERNAL");
  });
});

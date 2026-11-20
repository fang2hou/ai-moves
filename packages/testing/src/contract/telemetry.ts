import type { LogRecord } from "@ai-moves/contracts/logging";
import type { Telemetry } from "@ai-moves/contracts/ports/runtime";
import { expect } from "vitest";

import { definePortContract } from "./define.ts";

export interface TelemetryHarness {
  readonly telemetry: Telemetry;
  readonly records: () => readonly unknown[];
  readonly counts: () => readonly unknown[];
}

export const telemetryContract = definePortContract<TelemetryHarness>("Telemetry", [
  {
    name: "preserves structured log fields and keeps classified failures separate from attributes",
    run: ({ telemetry, records }) => {
      const retry: LogRecord = {
        ts: 1_795_000_000_000,
        level: "warn",
        event: "stage.retry",
        component: "analysis",
        trace_id: "trace_1",
        item_id: "item_1",
        stage: "deep",
        duration_ms: 65,
        err: { code: "UPSTREAM_TIMEOUT", kind: "retryable", message: "Upstream timed out" },
        attrs: { attempt: 2, dry_run: true },
      };
      const complete: LogRecord = {
        ts: retry.ts + 65,
        level: "info",
        component: retry.component,
        event: "stage.complete",
      };
      telemetry.log(retry);
      telemetry.log(complete);
      expect(records()).toEqual([retry, complete]);
    },
  },
  {
    name: "preserves metric values and dimensions across consecutive counts",
    run: ({ telemetry, counts }) => {
      telemetry.count("stage_retries", 2, { stage: "deep" });
      telemetry.count("stage_retries", 1, { stage: "triage" });
      telemetry.count("stage_completed", 1);
      expect(counts()).toEqual([
        { metric: "stage_retries", value: 2, dimensions: { stage: "deep" } },
        { metric: "stage_retries", value: 1, dimensions: { stage: "triage" } },
        { metric: "stage_completed", value: 1, dimensions: {} },
      ]);
    },
  },
]);

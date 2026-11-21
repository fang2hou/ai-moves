import type { LogRecord } from "@ai-moves/contracts/logging";
import type { Telemetry } from "@ai-moves/contracts/ports/runtime";

import { missingBinding } from "./failures.ts";

export interface CloudflareMetricRecord {
  readonly metric: string;
  readonly value: number;
  readonly dimensions: Readonly<Record<string, string>>;
}

export type CloudflareTelemetryWriter = (record: LogRecord | CloudflareMetricRecord) => void;

export function createCloudflareTelemetry(
  writer: CloudflareTelemetryWriter | undefined,
): Telemetry {
  if (writer === undefined) {
    throw missingBinding("CONFIG_INVALID", "telemetry writer");
  }
  return {
    log: writer,
    count: (metric, value, dimensions = {}) => {
      writer({ metric, value, dimensions: { ...dimensions } });
    },
  };
}

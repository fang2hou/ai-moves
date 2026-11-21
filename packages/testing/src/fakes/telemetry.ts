import type { LogRecord } from "@ai-moves/contracts/logging";
import type { Telemetry } from "@ai-moves/contracts/ports/runtime";

export interface RecordedCount {
  readonly metric: string;
  readonly value: number;
  readonly dimensions: Readonly<Record<string, string>>;
}

export interface RecordingTelemetry extends Telemetry {
  readonly records: readonly LogRecord[];
  readonly counts: readonly RecordedCount[];
  events(): string[];
  total(metric: string): number;
  clear(): void;
}

export function createRecordingTelemetry(): RecordingTelemetry {
  const records: LogRecord[] = [];
  const counts: RecordedCount[] = [];
  return {
    records,
    counts,
    log: (record) => {
      records.push(record);
    },
    count: (metric, value, dimensions = {}) => {
      counts.push({ metric, value, dimensions });
    },
    events: () => records.map((record) => record.event),
    total: (metric) =>
      counts
        .filter((count) => count.metric === metric)
        .reduce((sum, count) => sum + count.value, 0),
    clear: () => {
      records.length = 0;
      counts.length = 0;
    },
  };
}

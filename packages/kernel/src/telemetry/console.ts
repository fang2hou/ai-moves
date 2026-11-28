import type { LogRecord } from "@ai-news-tracker/contracts/logging";
import type { Telemetry } from "@ai-news-tracker/contracts/ports/runtime";

// Writes one JSON object per line to the console, which both Workers Logs and CloudWatch ingest as
// structured records. This is the only module allowed to touch `console`.
export function createConsoleTelemetry(): Telemetry {
  return {
    log: (record: LogRecord) => {
      const line = JSON.stringify(record);
      if (record.level === "error") {
        console.error(line);
      } else if (record.level === "warn") {
        console.warn(line);
      } else {
        console.log(line);
      }
    },
    count: (metric, value, dimensions = {}) => {
      console.log(JSON.stringify({ metric, value, dimensions }));
    },
  };
}

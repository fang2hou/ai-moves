import { z } from "zod";

import { ErrorSummarySchema } from "./errors.ts";
import { EntityIdSchema, EpochMsSchema, JsonObjectSchema, TraceIdSchema } from "./primitives.ts";
import { PipelineStageSchema } from "./states.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const LogLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof LogLevelSchema>;

// The fixed field set of architecture 11.1. Anything else goes into `attrs`, which the logger
// redacts before it reaches a sink.
export const LogRecordSchema = z.object({
  ts: EpochMsSchema,
  level: LogLevelSchema,
  event: z.string().min(1).max(128),
  component: z.string().min(1).max(64),
  trace_id: TraceIdSchema.optional(),
  source_id: EntityIdSchema.optional(),
  item_id: EntityIdSchema.optional(),
  stage: PipelineStageSchema.optional(),
  duration_ms: z.number().nonnegative().optional(),
  err: ErrorSummarySchema.optional(),
  attrs: JsonObjectSchema.optional(),
});
export type LogRecord = z.infer<typeof LogRecordSchema>;

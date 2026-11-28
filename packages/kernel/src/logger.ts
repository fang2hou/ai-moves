import { LOG_LEVELS, type LogLevel, type LogRecord } from "@ai-news-tracker/contracts/logging";
import type { Clock, Telemetry } from "@ai-news-tracker/contracts/ports/runtime";
import type { EntityId, TraceId } from "@ai-news-tracker/contracts/primitives";
import type { PipelineStage } from "@ai-news-tracker/contracts/states";

import { summarizeError } from "./errors/app-error.ts";
import { redactObject } from "./redact.ts";

export interface LogContext {
  readonly trace_id?: TraceId;
  readonly source_id?: EntityId;
  readonly item_id?: EntityId;
  readonly stage?: PipelineStage;
}

export interface LogFields extends LogContext {
  readonly duration_ms?: number;
  readonly err?: unknown;
  // Free-form details. Redacted before they reach the sink.
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  // Returns a logger that adds the given context to every record.
  child(context: LogContext & { readonly component?: string }): Logger;
}

export interface LoggerOptions {
  readonly telemetry: Telemetry;
  readonly clock: Clock;
  readonly component: string;
  readonly level?: LogLevel;
  readonly context?: LogContext;
}

function buildRecord(
  options: LoggerOptions,
  level: LogLevel,
  event: string,
  fields: LogFields,
): LogRecord {
  const merged = { ...options.context, ...fields };
  return {
    ts: options.clock.now(),
    level,
    event,
    component: options.component,
    ...(merged.trace_id === undefined ? {} : { trace_id: merged.trace_id }),
    ...(merged.source_id === undefined ? {} : { source_id: merged.source_id }),
    ...(merged.item_id === undefined ? {} : { item_id: merged.item_id }),
    ...(merged.stage === undefined ? {} : { stage: merged.stage }),
    ...(fields.duration_ms === undefined ? {} : { duration_ms: fields.duration_ms }),
    ...(fields.err === undefined ? {} : { err: summarizeError(fields.err) }),
    ...(fields.attrs === undefined ? {} : { attrs: redactObject(fields.attrs) }),
  };
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level ?? "info");
  const write = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    if (LOG_LEVELS.indexOf(level) >= threshold) {
      options.telemetry.log(buildRecord(options, level, event, fields));
    }
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: ({ component, ...context }) =>
      createLogger({
        ...options,
        component: component ?? options.component,
        context: { ...options.context, ...context },
      }),
  };
}

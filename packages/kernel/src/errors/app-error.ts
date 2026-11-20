import {
  type ErrorCode,
  type ErrorKind,
  errorKindOf,
  type ErrorSummary,
} from "@ai-moves/contracts/errors";
import type { JsonObject } from "@ai-moves/contracts/primitives";

import { redactText } from "../redact.ts";

export interface AppErrorOptions {
  readonly message?: string;
  readonly cause?: unknown;
  // Provider hint such as Retry-After, already converted to milliseconds.
  readonly retryAfterMs?: number;
  // Safe, non-secret details for logs. Never put payloads, URLs with credentials, or prompts here.
  readonly context?: JsonObject;
}

const MAX_SUMMARY_MESSAGE_LENGTH = 500;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly kind: ErrorKind;
  readonly retryAfterMs: number | undefined;
  readonly context: JsonObject;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(
      options.message ?? code,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AppError";
    this.code = code;
    this.kind = errorKindOf(code);
    this.retryAfterMs = options.retryAfterMs;
    this.context = options.context ?? {};
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

function describeUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return typeof value === "string" ? value : "Non-error value thrown";
}

// Anything that is not already classified becomes INTERNAL, which is retryable with a bounded
// number of attempts, so an unexpected failure can never be dropped silently.
export function toAppError(value: unknown, fallback: ErrorCode = "INTERNAL"): AppError {
  if (isAppError(value)) {
    return value;
  }
  return new AppError(fallback, { message: describeUnknown(value), cause: value });
}

export function summarizeError(value: unknown): ErrorSummary {
  const error = toAppError(value);
  return {
    code: error.code,
    kind: error.kind,
    message: redactText(error.message).slice(0, MAX_SUMMARY_MESSAGE_LENGTH),
  };
}

export function summarizeDurableError(error: Pick<ErrorSummary, "code" | "kind">): ErrorSummary {
  return { code: error.code, kind: error.kind, message: error.code };
}

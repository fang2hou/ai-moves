import { z } from "zod";

export const ERROR_KINDS = [
  "retryable",
  "permanent",
  "ambiguous",
  "budget",
  "validation",
  "security",
] as const;
export const ErrorKindSchema = z.enum(ERROR_KINDS);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

// Every code has exactly one kind, so a failure site only chooses a code and consumers only branch
// on the kind (architecture 4.5).
export const ERROR_CODE_KINDS = {
  INTERNAL: "retryable",
  UPSTREAM_UNAVAILABLE: "retryable",
  UPSTREAM_RATE_LIMITED: "retryable",
  UPSTREAM_TIMEOUT: "retryable",
  STORAGE_UNAVAILABLE: "retryable",
  QUEUE_UNAVAILABLE: "retryable",

  UPSTREAM_REJECTED: "permanent",
  NOT_FOUND: "permanent",
  STATE_CONFLICT: "permanent",
  SECRET_MISSING: "permanent",
  ATTEMPTS_EXHAUSTED: "permanent",
  CONTENT_UNSUPPORTED: "permanent",

  OUTCOME_UNKNOWN: "ambiguous",

  BUDGET_EXHAUSTED: "budget",

  CONFIG_INVALID: "validation",
  INPUT_INVALID: "validation",
  MESSAGE_INVALID: "validation",
  ROW_INVALID: "validation",
  UPSTREAM_RESPONSE_INVALID: "validation",
  LLM_OUTPUT_INVALID: "validation",
  FIDELITY_CHECK_FAILED: "validation",

  SSRF_BLOCKED: "security",
  HOST_NOT_ALLOWED: "security",
  SUSPECTED_INJECTION: "security",
  UNAUTHENTICATED: "security",
  FORBIDDEN: "security",
} as const satisfies Record<string, ErrorKind>;

export type ErrorCode = keyof typeof ERROR_CODE_KINDS;

function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_CODE_KINDS, value);
}

export const ERROR_CODES: readonly ErrorCode[] = Object.keys(ERROR_CODE_KINDS).filter(isErrorCode);

export const ErrorCodeSchema = z.custom<ErrorCode>(
  (value) => typeof value === "string" && isErrorCode(value),
  "Unknown error code",
);

export function errorKindOf(code: ErrorCode): ErrorKind {
  return ERROR_CODE_KINDS[code];
}

export const ErrorSummarySchema = z
  .object({
    code: ErrorCodeSchema,
    kind: ErrorKindSchema,
    message: z.string().max(500),
  })
  .refine((summary) => summary.kind === errorKindOf(summary.code), {
    message: "Error kind does not match the error code",
    path: ["kind"],
  });
export type ErrorSummary = z.infer<typeof ErrorSummarySchema>;

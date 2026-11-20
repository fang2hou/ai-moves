import type { ErrorCode } from "@ai-moves/contracts/errors";
import type { JsonObject } from "@ai-moves/contracts/primitives";
import type { z } from "zod";

import { AppError } from "./errors/app-error.ts";

export type BoundaryErrorCode = Extract<
  ErrorCode,
  | "CONFIG_INVALID"
  | "INPUT_INVALID"
  | "MESSAGE_INVALID"
  | "ROW_INVALID"
  | "UPSTREAM_RESPONSE_INVALID"
  | "LLM_OUTPUT_INVALID"
>;

const MAX_REPORTED_ISSUES = 10;

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "(root)" : path.map(String).join(".");
}

// Validates data crossing a process boundary. The error names where the data is wrong and why, but
// never echoes the data itself, so a rejected payload cannot leak a secret into logs.
export function parseBoundary<Output>(
  schema: z.ZodType<Output>,
  input: unknown,
  code: BoundaryErrorCode,
  context: JsonObject = {},
): Output {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: formatPath(issue.path),
    issue: issue.code,
  }));
  const summary = issues.map((issue) => `${issue.path} (${issue.issue})`).join(", ");
  throw new AppError(code, {
    message: `${code}: ${summary}`,
    context: { ...context, issues, issue_count: result.error.issues.length },
  });
}

export function parseJsonBoundary<Output>(
  schema: z.ZodType<Output>,
  text: string,
  code: BoundaryErrorCode,
  context: JsonObject = {},
): Output {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AppError(code, { message: `${code}: not valid JSON`, cause: error, context });
  }
  return parseBoundary(schema, parsed, code, context);
}

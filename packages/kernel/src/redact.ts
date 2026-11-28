import type { JsonObject, JsonValue } from "@ai-news-tracker/contracts/primitives";

export const REDACTED = "[REDACTED]";

const MAX_STRING_LENGTH = 2000;
const MAX_DEPTH = 6;
const MAX_ARRAY_LENGTH = 50;
const TRUNCATED_SUFFIX = "...[truncated]";

// Keys whose values are never logged: credentials, webhook URLs, and prompt bodies
// (architecture 10 and 14.1).
const SENSITIVE_KEY =
  /secret|token|password|passwd|authorization|api[_-]?key|webhook|cookie|credential|signature|prompt|messages/i;

const SECRET_PATTERNS: readonly RegExp[] = [
  /https:\/\/hooks\.slack\.com\/[^\s"'<>]+/gi,
  /https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/[^\s"'<>]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
];

const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

export function redactText(text: string): string {
  let result = text.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result.length > MAX_STRING_LENGTH
    ? `${result.slice(0, MAX_STRING_LENGTH)}${TRUNCATED_SUFFIX}`
    : result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactAt(value: unknown, depth: number): JsonValue {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (depth >= MAX_DEPTH) {
    return "[depth limit]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((entry: unknown) => redactAt(entry, depth + 1));
  }
  if (isPlainObject(value)) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
        continue;
      }
      result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactAt(entry, depth + 1);
    }
    return result;
  }
  return `[${typeof value}]`;
}

export function redact(value: unknown): JsonValue {
  return redactAt(value, 0);
}

export function redactObject(value: Readonly<Record<string, unknown>>): JsonObject {
  const result = redactAt(value, 0);
  return isPlainObject(result) ? result : {};
}

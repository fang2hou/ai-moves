import type { HttpFetch } from "@ai-moves/contracts/ports/runtime";
import { AppError, isAppError } from "@ai-moves/kernel/errors/app-error";
import { withTimeout } from "@ai-moves/kernel/timeout";
import type { ZodType } from "zod";

export interface ApiOptions {
  readonly fetch: HttpFetch;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
}

export const USER_AGENT = "ai-moves/0.1";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isRedirect(response: Response): boolean {
  return REDIRECT_STATUSES.has(response.status);
}

export function withDeadline<Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  timeoutMs: number,
): Promise<Value> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new AppError("CONFIG_INVALID", { message: "Invalid source timeout" });
  }
  return withTimeout(
    async (signal) => {
      try {
        return await operation(signal);
      } catch (cause) {
        if (isAppError(cause)) {
          throw cause;
        }
        signal.throwIfAborted();
        if (
          typeof cause === "object" &&
          cause !== null &&
          "name" in cause &&
          cause.name === "TimeoutError"
        ) {
          throw new AppError("UPSTREAM_TIMEOUT", { message: "Upstream transport timed out" });
        }
        throw new AppError("UPSTREAM_UNAVAILABLE", { message: "Upstream transport failed" });
      }
    },
    { timeoutMs },
  );
}

export function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

export function checkManualResponse(
  request: Request,
  response: Response,
  code: "SSRF_BLOCKED" | "HOST_NOT_ALLOWED",
): void {
  if (response.redirected || (response.url !== "" && response.url !== request.url)) {
    discardBody(response);
    throw new AppError(code, { message: "Transport did not return the requested URL" });
  }
}

export function redirectLocation(response: Response): string {
  const location = response.headers.get("location");
  discardBody(response);
  if (location === null || location === "") {
    throw invalidResponse("Redirect is missing its target");
  }
  return location;
}

function seconds(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) {
    return undefined;
  }
  const milliseconds = Number(value) * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function retryAfter(headers: Headers, github: boolean): number | undefined {
  const value = headers.get("retry-after");
  const relative = seconds(value);
  if (relative !== undefined) {
    return relative;
  }
  const date = Date.parse(headers.get("date") ?? "");
  let deadline: number | undefined;
  if (value !== null) {
    deadline = Date.parse(value);
  } else if (github && headers.get("x-ratelimit-remaining") === "0") {
    deadline = seconds(headers.get("x-ratelimit-reset"));
  }
  return deadline !== undefined && Number.isSafeInteger(deadline - date)
    ? Math.max(0, deadline - date)
    : undefined;
}

export function rejectStatus(response: Response, githubLimited = false): never {
  discardBody(response);
  const { status } = response;
  const context = { status };
  if (status === 429 || githubLimited) {
    const retryAfterMs = retryAfter(response.headers, githubLimited);
    throw new AppError("UPSTREAM_RATE_LIMITED", {
      context,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (status === 408) {
    throw new AppError("UPSTREAM_TIMEOUT", { context });
  }
  if (status >= 500) {
    throw new AppError("UPSTREAM_UNAVAILABLE", { context });
  }
  throw new AppError("UPSTREAM_REJECTED", { context });
}

export function invalidResponse(message: string): AppError {
  return new AppError("UPSTREAM_RESPONSE_INVALID", { message });
}

export function parseUpstream<Value>(schema: ZodType<Value>, input: unknown): Value {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw invalidResponse("Upstream payload does not match the expected shape");
  }
  return parsed.data;
}

export async function readText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { text: "", truncated: false };
  }
  const decoder = new TextDecoder();
  let text = "";
  let remaining = maxBytes;
  let finished = false;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        finished = true;
        return { text: text + decoder.decode(), truncated: false };
      }
      if (chunk.value.byteLength > remaining) {
        return {
          text: text + decoder.decode(chunk.value.subarray(0, remaining), { stream: true }),
          truncated: true,
        };
      }
      remaining -= chunk.value.byteLength;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) {
      cancel();
    }
    reader.releaseLock();
  }
}

export async function readJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const { text, truncated } = await readText(response, maxBytes, signal);
  if (truncated) {
    throw invalidResponse("Upstream JSON exceeded the byte limit");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse("Upstream response is not JSON");
  }
}

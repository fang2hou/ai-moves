import type { ErrorCode } from "@ai-moves/contracts/errors";

import { AppError, toAppError } from "./errors/app-error.ts";

export interface TimeoutOptions {
  readonly timeoutMs: number;
  // UPSTREAM_TIMEOUT suits reads and requests that were never written. A caller that may already
  // have caused a side effect passes OUTCOME_UNKNOWN so the work is held instead of retried.
  readonly code?: Extract<ErrorCode, "UPSTREAM_TIMEOUT" | "OUTCOME_UNKNOWN">;
  readonly signal?: AbortSignal;
}

// Runs an operation with a deadline. The operation receives a signal that aborts on timeout or
// when the caller's signal aborts, and should pass it to whatever I/O it performs. The returned
// promise settles at the deadline or on cancellation even if the operation ignores the signal.
export async function withTimeout<Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  options: TimeoutOptions,
): Promise<Value> {
  const caller = options.signal;
  if (caller?.aborted === true) {
    throw toAppError(caller.reason);
  }
  const controller = new AbortController();
  const code = options.code ?? "UPSTREAM_TIMEOUT";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCallerAbort: (() => void) | undefined;

  const interrupted = new Promise<never>((_resolve, reject) => {
    const interrupt = (error: AppError): void => {
      controller.abort(error);
      reject(error);
    };
    timer = setTimeout(() => {
      interrupt(
        new AppError(code, {
          message: `${code}: no result within ${options.timeoutMs} ms`,
          context: { timeout_ms: options.timeoutMs },
        }),
      );
    }, options.timeoutMs);
    onCallerAbort = () => interrupt(toAppError(caller?.reason));
    caller?.addEventListener("abort", onCallerAbort, { once: true });
  });

  try {
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    if (onCallerAbort !== undefined) {
      caller?.removeEventListener("abort", onCallerAbort);
    }
  }
}

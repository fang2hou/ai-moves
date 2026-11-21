import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError, isAppError } from "../src/errors/app-error.ts";
import { withTimeout } from "../src/timeout.ts";

function never(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function settle(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("returns the result and clears its timer when the operation finishes in time", async () => {
    const result = await withTimeout(() => Promise.resolve("ok"), { timeoutMs: 1000 });
    expect(result).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with UPSTREAM_TIMEOUT and aborts the operation at the deadline", async () => {
    let seen: AbortSignal | undefined;
    const pending = settle(
      withTimeout(
        (signal) => {
          seen = signal;
          return never(signal);
        },
        { timeoutMs: 10_000 },
      ),
    );
    await vi.advanceTimersByTimeAsync(9999);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) {
      return;
    }
    expect(error.code).toBe("UPSTREAM_TIMEOUT");
    expect(error.kind).toBe("retryable");
    expect(error.context).toEqual({ timeout_ms: 10_000 });
    expect(seen?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies the timeout as ambiguous when the caller says a side effect may have happened", async () => {
    const pending = settle(withTimeout(never, { timeoutMs: 50, code: "OUTCOME_UNKNOWN" }));
    await vi.advanceTimersByTimeAsync(50);
    const error = await pending;
    expect(isAppError(error) && error.kind).toBe("ambiguous");
  });

  it("passes the operation's own failure through unchanged", async () => {
    const failure = new AppError("UPSTREAM_REJECTED");
    const error = await settle(withTimeout(() => Promise.reject(failure), { timeoutMs: 1000 }));
    expect(error).toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts when the caller's signal aborts", async () => {
    const caller = new AbortController();
    const reason = new AppError("INTERNAL", { message: "shutting down" });
    const pending = settle(withTimeout(never, { timeoutMs: 1000, signal: caller.signal }));
    caller.abort(reason);
    expect(await pending).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects without starting the operation when the caller's signal is already aborted", async () => {
    const caller = new AbortController();
    const reason = new AppError("INTERNAL", { message: "shutting down" });
    caller.abort(reason);
    const operation = vi.fn<(signal: AbortSignal) => Promise<never>>(never);
    const error = await settle(withTimeout(operation, { timeoutMs: 1000, signal: caller.signal }));
    expect(error).toBe(reason);
    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles on cancellation even when the operation ignores its signal", async () => {
    const caller = new AbortController();
    const pending = settle(
      withTimeout(() => new Promise<never>(() => undefined), {
        timeoutMs: 1000,
        signal: caller.signal,
      }),
    );
    caller.abort("stop");
    const error = await pending;
    expect(isAppError(error) && error.code).toBe("INTERNAL");
    expect(isAppError(error) && error.message).toBe("stop");
  });

  it("settles at the deadline even when the operation ignores its signal", async () => {
    const pending = settle(
      withTimeout(() => new Promise<never>(() => undefined), { timeoutMs: 20 }),
    );
    await vi.advanceTimersByTimeAsync(20);
    const error = await pending;
    expect(isAppError(error) && error.code).toBe("UPSTREAM_TIMEOUT");
  });
});

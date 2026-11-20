import type { ErrorKind } from "@ai-moves/contracts/errors";

import { toAppError } from "./app-error.ts";

// What a queue consumer does with a failed unit of work. Consumers branch on this and nothing
// else; they never interpret HTTP status codes themselves (architecture 4.5).
//
// - retry: leave the work claimable and try again after a delay.
// - fail: move to the failed terminal state.
// - hold: the outcome is unknowable; record it and never retry automatically.
// - skip: budget is exhausted; mark skipped and do not queue for the next day.
// - quarantine: a security rule fired; flag the work and never retry or push it.
export const FAILURE_ACTIONS = ["retry", "fail", "hold", "skip", "quarantine"] as const;
export type FailureAction = (typeof FAILURE_ACTIONS)[number];

export const FAILURE_ACTION_BY_KIND = {
  retryable: "retry",
  permanent: "fail",
  ambiguous: "hold",
  budget: "skip",
  validation: "fail",
  security: "quarantine",
} as const satisfies Record<ErrorKind, FailureAction>;

export interface RetryPolicy {
  readonly maxAttempts: number;
  // Delay before attempt n + 1 is `backoffSeconds[n - 1]`; the last entry repeats.
  readonly backoffSeconds: readonly number[];
  readonly maxDelaySeconds?: number;
}

export type FailureDecision =
  | { readonly action: "retry"; readonly delayMs: number }
  | { readonly action: "fail"; readonly exhausted: boolean }
  | { readonly action: "hold" | "skip" | "quarantine" };

export function retryDelayMs(
  policy: RetryPolicy,
  attempt: number,
  retryAfterMs: number | undefined,
): number {
  const index = Math.min(Math.max(attempt, 1), policy.backoffSeconds.length) - 1;
  const scheduledMs = (policy.backoffSeconds[index] ?? 0) * 1000;
  // A provider hint can lengthen the wait but never shorten the schedule.
  const requestedMs = Math.max(scheduledMs, retryAfterMs ?? 0);
  return policy.maxDelaySeconds === undefined
    ? requestedMs
    : Math.min(requestedMs, policy.maxDelaySeconds * 1000);
}

// `attempt` counts attempts made so far, including the one that just failed, starting at 1.
export function decideFailure(
  error: unknown,
  attempt: number,
  policy: RetryPolicy,
): FailureDecision {
  const appError = toAppError(error);
  const action = FAILURE_ACTION_BY_KIND[appError.kind];
  if (action === "retry") {
    return attempt >= policy.maxAttempts
      ? { action: "fail", exhausted: true }
      : { action: "retry", delayMs: retryDelayMs(policy, attempt, appError.retryAfterMs) };
  }
  if (action === "fail") {
    return { action: "fail", exhausted: false };
  }
  return { action };
}

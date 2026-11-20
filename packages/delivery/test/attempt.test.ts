import type { Delivery } from "@ai-moves/contracts/entities";
import type { DeliveryTransition } from "@ai-moves/contracts/ports/storage";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { expect, it } from "vitest";

import { finishSend } from "../src/attempt.ts";
import { recoverExpiredSend } from "../src/recovery.ts";

function fixture(): Delivery {
  return {
    id: "delivery",
    alert_id: "alert",
    destination_id: "destination",
    idempotency_key: "a".repeat(64),
    state: "sending",
    state_updated_at: 100,
    attempts: 1,
    provider_message_id: null,
    last_error: null,
    next_attempt_at: null,
    expires_at: 10000,
    lang: "en",
    dry_run: false,
    suppressed_reason: null,
    created_at: 100,
  };
}

async function failRetryably(): Promise<never> {
  throw new AppError("UPSTREAM_UNAVAILABLE", { message: "arbitrary benign diagnostic text" });
}

it("bounds retryable errors and schedules the configured backoff", async () => {
  const transitions: DeliveryTransition[] = [];
  const deliveries = {
    transition: async (change: DeliveryTransition) => {
      transitions.push(change);
      return true;
    },
  };
  const clock = { now: () => 200 };
  const options = { maxAttempts: 2, backoffSeconds: [3] };
  await finishSend(deliveries, clock, fixture(), failRetryably, options);
  await finishSend(deliveries, clock, { ...fixture(), attempts: 2 }, failRetryably, options);
  expect(transitions[0]).toMatchObject({
    to: "failed_retryable",
    expected: { attempts: 1, state_updated_at: 100 },
    patch: {
      last_error: {
        code: "UPSTREAM_UNAVAILABLE",
        kind: "retryable",
        message: "UPSTREAM_UNAVAILABLE",
      },
    },
  });
  expect(transitions[0]?.patch?.next_attempt_at).toBeGreaterThanOrEqual(2600);
  expect(transitions[0]?.patch?.next_attempt_at).toBeLessThanOrEqual(3800);
  expect(transitions[1]).toMatchObject({
    to: "failed_permanent",
    patch: { last_error: { code: "ATTEMPTS_EXHAUSTED" }, next_attempt_at: null },
  });
});

it("marks ambiguous sends and expired leases unknown without retrying", async () => {
  const transitions: DeliveryTransition[] = [];
  const deliveries = {
    transition: async (change: DeliveryTransition) => {
      transitions.push(change);
      return true;
    },
  };
  const claimed = fixture();
  await finishSend(
    deliveries,
    { now: () => 200 },
    claimed,
    async () => {
      throw new AppError("OUTCOME_UNKNOWN", { message: "arbitrary benign diagnostic text" });
    },
    { maxAttempts: 3, backoffSeconds: [1] },
  );
  expect(await recoverExpiredSend(deliveries, claimed, 199, 100)).toBe(false);
  expect(await recoverExpiredSend(deliveries, claimed, 200, 100)).toBe(true);
  expect(transitions.map((change) => change.to)).toEqual(["unknown", "unknown"]);
  expect(transitions.map((change) => change.patch)).toEqual([
    {
      last_error: { code: "OUTCOME_UNKNOWN", kind: "ambiguous", message: "OUTCOME_UNKNOWN" },
      next_attempt_at: null,
    },
    {
      last_error: { code: "OUTCOME_UNKNOWN", kind: "ambiguous", message: "OUTCOME_UNKNOWN" },
      next_attempt_at: null,
    },
  ]);
  expect(transitions[1]?.expected).toEqual({ attempts: 1, state_updated_at: 100 });
});

it("treats unclassified send failures as unknown without persisting diagnostics", async () => {
  const transitions: DeliveryTransition[] = [];
  await finishSend(
    {
      transition: async (change) => {
        transitions.push(change);
        return true;
      },
    },
    { now: () => 200 },
    fixture(),
    async () => {
      throw new Error("arbitrary benign diagnostic text");
    },
    { maxAttempts: 3, backoffSeconds: [1] },
  );
  expect(transitions[0]).toMatchObject({
    to: "unknown",
    patch: {
      last_error: { code: "OUTCOME_UNKNOWN", kind: "ambiguous", message: "OUTCOME_UNKNOWN" },
      next_attempt_at: null,
    },
  });
});

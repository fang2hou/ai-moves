import { describe, expect, it } from "vitest";

import {
  DELIVERY_STATE_TRANSITIONS,
  DELIVERY_STATES,
  DELIVERY_TERMINAL_STATES,
  type DeliveryState,
  isDeliveryStateTerminal,
  isDeliveryTransitionAllowed,
  isItemStateTerminal,
  isItemTransitionAllowed,
  ITEM_LEASED_STATES,
  ITEM_STATE_TRANSITIONS,
  ITEM_STATES,
  ITEM_TERMINAL_STATES,
  type ItemState,
} from "../src/states.ts";

function edges<State extends string>(
  table: Readonly<Record<State, readonly State[]>>,
  states: readonly State[],
): string[] {
  return states.flatMap((from) => table[from].map((to) => `${from} -> ${to}`)).toSorted();
}

function reachable<State extends string>(
  table: Readonly<Record<State, readonly State[]>>,
  start: State,
): Set<State> {
  const seen = new Set<State>([start]);
  const queue: State[] = [start];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const target of table[next]) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

describe("item state machine", () => {
  it("contains exactly the edges of architecture 4.3 plus the recovery edges of 4.5", () => {
    const diagram = [
      "discovered -> tracking",
      "discovered -> candidate",
      "discovered -> skipped_trivial",
      "tracking -> candidate",
      "tracking -> archived",
      "candidate -> triaging",
      "triaging -> triaged_reject",
      "triaging -> triaged_pass",
      "triaging -> skipped_budget",
      "triaged_reject -> candidate",
      "triaged_pass -> analyzing",
      "analyzing -> analyzed",
      "analyzing -> failed_analysis",
      "analyzed -> alerted",
      "analyzed -> feed_only",
      "alerted -> candidate",
      "alerted -> archived",
      "feed_only -> archived",
    ];
    const recovery = [
      "triaging -> candidate",
      "triaging -> failed_analysis",
      "analyzing -> triaged_pass",
    ];
    expect(edges(ITEM_STATE_TRANSITIONS, ITEM_STATES)).toEqual(
      [...diagram, ...recovery].toSorted(),
    );
  });

  it("reaches every state from discovered", () => {
    expect([...reachable<ItemState>(ITEM_STATE_TRANSITIONS, "discovered")].toSorted()).toEqual(
      ITEM_STATES.toSorted(),
    );
  });

  it("treats exactly the states without outgoing edges as terminal", () => {
    expect(ITEM_TERMINAL_STATES.toSorted()).toEqual([
      "archived",
      "failed_analysis",
      "skipped_budget",
      "skipped_trivial",
    ]);
    for (const state of ITEM_STATES) {
      expect(isItemStateTerminal(state)).toBe(ITEM_STATE_TRANSITIONS[state].length === 0);
    }
  });

  it("answers transition checks from the table for every pair", () => {
    for (const from of ITEM_STATES) {
      for (const to of ITEM_STATES) {
        const targets: readonly ItemState[] = ITEM_STATE_TRANSITIONS[from];
        expect(isItemTransitionAllowed(from, to)).toBe(targets.includes(to));
      }
    }
  });

  it("gives every leased state a way back for the sweeper", () => {
    expect(ITEM_LEASED_STATES).toEqual({ triaging: "triage", analyzing: "deep" });
    expect(isItemTransitionAllowed("triaging", "candidate")).toBe(true);
    expect(isItemTransitionAllowed("analyzing", "triaged_pass")).toBe(true);
  });
});

describe("delivery state machine", () => {
  it("contains exactly the edges of architecture 4.4", () => {
    expect(edges(DELIVERY_STATE_TRANSITIONS, DELIVERY_STATES)).toEqual(
      [
        "pending -> sending",
        "pending -> expired",
        "pending -> suppressed",
        "sending -> sent",
        "sending -> failed_retryable",
        "sending -> failed_permanent",
        "sending -> unknown",
        "failed_retryable -> sending",
        "failed_retryable -> failed_permanent",
        "failed_retryable -> expired",
      ].toSorted(),
    );
  });

  it("has the terminal states the architecture names", () => {
    expect(DELIVERY_TERMINAL_STATES.toSorted()).toEqual([
      "expired",
      "failed_permanent",
      "sent",
      "suppressed",
      "unknown",
    ]);
    for (const state of DELIVERY_STATES) {
      expect(isDeliveryStateTerminal(state)).toBe(DELIVERY_TERMINAL_STATES.includes(state));
    }
  });

  it("never retries automatically once the outcome is unknown", () => {
    const fromUnknown: readonly DeliveryState[] = DELIVERY_STATE_TRANSITIONS.unknown;
    expect(fromUnknown).toEqual([]);
    expect(isDeliveryTransitionAllowed("unknown", "sending")).toBe(false);
    expect(isDeliveryTransitionAllowed("sent", "sending")).toBe(false);
  });
});

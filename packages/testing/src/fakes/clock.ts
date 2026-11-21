import type { Clock } from "@ai-moves/contracts/ports/runtime";
import type { EpochMs } from "@ai-moves/contracts/primitives";

export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(now: EpochMs): void;
}

// 2026-11-20T00:00:00Z. Tests start here unless they say otherwise.
export const FAKE_CLOCK_START: EpochMs = 1_795_132_800_000;

export function createFakeClock(start: EpochMs = FAKE_CLOCK_START): FakeClock {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    set: (next) => {
      now = next;
    },
  };
}

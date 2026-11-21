import { EntityIdSchema } from "@ai-moves/contracts/primitives";
import { afterEach, describe, expect, it, vi } from "vitest";

import { systemClock } from "../src/clock.ts";
import { createIdGen } from "../src/id.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.useRealTimers();
});

describe("createIdGen", () => {
  it("is fully determined by the clock and the random source", () => {
    const ids = createIdGen({
      clock: { now: () => 0x0123456789ab },
      randomBytes: (length) => new Uint8Array(length).fill(0xff),
    });
    expect(ids.next()).toBe("01234567-89ab-7fff-bfff-ffffffffffff");
    expect(ids.next()).toBe("01234567-89ab-7fff-bfff-ffffffffffff");
  });

  it("sets the version and variant bits whatever the random bytes are", () => {
    const ids = createIdGen({
      clock: { now: () => 0 },
      randomBytes: (length) => new Uint8Array(length),
    });
    expect(ids.next()).toBe("00000000-0000-7000-8000-000000000000");
  });

  it("sorts by creation time", () => {
    let now = 1_795_000_000_000;
    const ids = createIdGen({
      clock: { now: () => now },
      randomBytes: (length) => new Uint8Array(length).fill(0xff),
    });
    const first = ids.next();
    now += 1;
    const second = ids.next();
    now += 86_400_000;
    const third = ids.next();
    expect([third, first, second].toSorted()).toEqual([first, second, third]);
  });

  it("produces unique, schema-valid ids with the default random source", () => {
    const ids = createIdGen({ clock: { now: () => 1_795_000_000_000 } });
    const generated = Array.from({ length: 200 }, () => ids.next());
    expect(new Set(generated).size).toBe(200);
    for (const id of generated) {
      expect(id).toMatch(UUID_V7);
      expect(EntityIdSchema.safeParse(id).success).toBe(true);
    }
  });
});

describe("systemClock", () => {
  it("reads the wall clock in epoch milliseconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_795_000_000_123);
    expect(systemClock.now()).toBe(1_795_000_000_123);
    vi.advanceTimersByTime(877);
    expect(systemClock.now()).toBe(1_795_000_001_000);
  });
});

import type { Cache } from "@ai-moves/contracts/ports/storage";
import { expect } from "vitest";

import { definePortContract } from "./define.ts";

export interface CacheHarness {
  readonly cache: Cache;
}

export interface CacheExpiryHarness extends CacheHarness {
  // Moves the implementation's notion of time forward.
  readonly advanceSeconds: (seconds: number) => Promise<void> | void;
}

const ttl = { ttlSeconds: 60 };

export const cacheContract = definePortContract<CacheHarness>("Cache", [
  {
    name: "reports a missing key as null",
    run: async ({ cache }) => {
      expect(await cache.get("feed:latest")).toBeNull();
    },
  },
  {
    name: "returns what was set and overwrites on a second set",
    run: async ({ cache }) => {
      await cache.set("feed:latest", "v1", ttl);
      expect(await cache.get("feed:latest")).toBe("v1");
      await cache.set("feed:latest", "v2", ttl);
      expect(await cache.get("feed:latest")).toBe("v2");
    },
  },
  {
    name: "keeps keys independent",
    run: async ({ cache }) => {
      await cache.set("a", "1", ttl);
      await cache.set("b", "2", ttl);
      await cache.delete("a");
      expect(await cache.get("a")).toBeNull();
      expect(await cache.get("b")).toBe("2");
    },
  },
  {
    name: "deletes idempotently",
    run: async ({ cache }) => {
      await cache.delete("never-set");
      await cache.set("a", "1", ttl);
      await cache.delete("a");
      await cache.delete("a");
      expect(await cache.get("a")).toBeNull();
    },
  },
  {
    name: "rejects a time to live that is not a positive integer",
    run: async ({ cache }) => {
      for (const ttlSeconds of [0, -5, 1.5]) {
        await expect(cache.set("a", "1", { ttlSeconds })).rejects.toMatchObject({
          code: "INPUT_INVALID",
        });
      }
      expect(await cache.get("a")).toBeNull();
    },
  },
]);

// For implementations whose clock a test can control.
export const cacheExpiryContract = definePortContract<CacheExpiryHarness>("Cache expiry", [
  {
    name: "serves a value until its time to live has passed",
    run: async ({ cache, advanceSeconds }) => {
      await cache.set("feed:latest", "v1", ttl);
      await advanceSeconds(59);
      expect(await cache.get("feed:latest")).toBe("v1");
      await advanceSeconds(1);
      expect(await cache.get("feed:latest")).toBeNull();
    },
  },
  {
    name: "restarts the time to live when a key is overwritten",
    run: async ({ cache, advanceSeconds }) => {
      await cache.set("feed:latest", "v1", ttl);
      await advanceSeconds(50);
      await cache.set("feed:latest", "v2", ttl);
      await advanceSeconds(50);
      expect(await cache.get("feed:latest")).toBe("v2");
    },
  },
]);

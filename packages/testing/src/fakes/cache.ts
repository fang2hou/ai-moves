import type { Clock } from "@ai-moves/contracts/ports/runtime";
import type { Cache } from "@ai-moves/contracts/ports/storage";
import type { EpochMs } from "@ai-moves/contracts/primitives";
import { AppError } from "@ai-moves/kernel/errors/app-error";

interface CacheEntry {
  readonly value: string;
  readonly expiresAt: EpochMs;
}

// Strongly consistent, unlike the KV store it stands in for. Code under test must not rely on
// that: the cache never carries correctness (architecture 2.1).
export function createInMemoryCache(clock: Clock): Cache {
  const entries = new Map<string, CacheEntry>();
  return {
    get: (key) => {
      const entry = entries.get(key);
      if (entry !== undefined && entry.expiresAt <= clock.now()) {
        entries.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(entry?.value ?? null);
    },
    set: (key, value, options) => {
      if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds <= 0) {
        return Promise.reject(
          new AppError("INPUT_INVALID", {
            message: "INPUT_INVALID: ttlSeconds must be a positive integer",
            context: { ttl_seconds: options.ttlSeconds },
          }),
        );
      }
      entries.set(key, { value, expiresAt: clock.now() + options.ttlSeconds * 1000 });
      return Promise.resolve();
    },
    delete: (key) => {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}

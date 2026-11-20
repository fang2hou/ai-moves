import type { Clock } from "@ai-moves/contracts/ports/runtime";
import type { Cache } from "@ai-moves/contracts/ports/storage";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { missingBinding, platformFailure } from "./failures.ts";

export interface KVCacheBinding {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface StoredCacheValue {
  readonly expiresAt: number;
  readonly value: string;
}

const MIN_KV_EXPIRATION_TTL_SECONDS = 60;

function validateTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new AppError("INPUT_INVALID", {
      message: "INPUT_INVALID: ttlSeconds must be a positive integer",
      context: { ttl_seconds: ttlSeconds },
    });
  }
}

function encodeValue(value: string, expiresAt: number): string {
  return JSON.stringify({ expiresAt, value } satisfies StoredCacheValue);
}

function decodeValue(encoded: string): StoredCacheValue {
  const value: unknown = JSON.parse(encoded);
  if (
    typeof value !== "object" ||
    value === null ||
    !("expiresAt" in value) ||
    !("value" in value) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    typeof value.value !== "string"
  ) {
    throw new AppError("STORAGE_UNAVAILABLE", {
      message: "STORAGE_UNAVAILABLE: cached KV value is invalid",
    });
  }
  return { expiresAt: value.expiresAt, value: value.value };
}

export function createCloudflareCache(namespace: KVCacheBinding | undefined, clock: Clock): Cache {
  if (namespace === undefined) {
    throw missingBinding("CONFIG_INVALID", "KV namespace");
  }
  return {
    get: async (key) => {
      try {
        const encoded = await namespace.get(key, "text");
        if (encoded === null) {
          return null;
        }
        const stored = decodeValue(encoded);
        if (stored.expiresAt <= clock.now()) {
          await namespace.delete(key);
          return null;
        }
        return stored.value;
      } catch (error) {
        throw platformFailure("STORAGE_UNAVAILABLE", "KV get", error);
      }
    },
    set: async (key, value, options) => {
      validateTtl(options.ttlSeconds);
      const encoded = encodeValue(value, clock.now() + options.ttlSeconds * 1000);
      try {
        await namespace.put(key, encoded, {
          expirationTtl: Math.max(MIN_KV_EXPIRATION_TTL_SECONDS, options.ttlSeconds),
        });
      } catch (error) {
        throw platformFailure("STORAGE_UNAVAILABLE", "KV put", error);
      }
    },
    delete: async (key) => {
      try {
        await namespace.delete(key);
      } catch (error) {
        throw platformFailure("STORAGE_UNAVAILABLE", "KV delete", error);
      }
    },
  };
}

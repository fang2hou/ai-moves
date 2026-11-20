import { describe, expect, it } from "vitest";

import { createCloudflareBlobStore } from "../src/blob-store.ts";
import { createCloudflareCache } from "../src/cache.ts";
import { createCloudflareSecretProvider } from "../src/secrets.ts";
import { createCloudflareTelemetry } from "../src/telemetry.ts";

const clock = { now: () => 0 };

describe("binding validation", () => {
  it("rejects missing platform bindings with classified errors", () => {
    expect(() => createCloudflareBlobStore(undefined)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID", kind: "validation" }),
    );
    expect(() => createCloudflareCache(undefined, clock)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID", kind: "validation" }),
    );
    expect(() => createCloudflareTelemetry(undefined)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID", kind: "validation" }),
    );
  });

  it("classifies absent, empty, and non-string secret bindings as missing", async () => {
    const provider = createCloudflareSecretProvider({
      __proto__: { INHERITED: "synthetic" },
      EMPTY: "",
      NON_STRING: 3,
    });
    for (const ref of ["EMPTY", "NON_STRING", "ABSENT", "INHERITED"]) {
      await expect(provider.get(ref)).rejects.toMatchObject({
        code: "SECRET_MISSING",
        message: "SECRET_MISSING",
        context: {},
      });
    }
  });
});

describe("classified platform failures", () => {
  it("maps R2 failures to storage unavailable", async () => {
    const store = createCloudflareBlobStore({
      get: () => Promise.reject(new Error("r2 get")),
      head: () => Promise.reject(new Error("r2 head")),
      put: () => Promise.reject(new Error("r2 put")),
    });
    await expect(store.get("sha256/unknown")).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      kind: "retryable",
    });
  });

  it("maps KV failures to storage unavailable", async () => {
    const cache = createCloudflareCache(
      {
        get: () => Promise.reject(new Error("kv get")),
        put: () => Promise.reject(new Error("kv put")),
        delete: () => Promise.reject(new Error("kv delete")),
      },
      clock,
    );
    await expect(cache.set("a", "b", { ttlSeconds: 60 })).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      kind: "retryable",
    });
  });
});

import { blobStoreContract } from "@ai-moves/testing/contract/blob-store";
import { cacheContract, cacheExpiryContract } from "@ai-moves/testing/contract/cache";
import { runPortContract } from "@ai-moves/testing/contract/define";

import { createCloudflareBlobStore } from "../src/blob-store.ts";
import { createCloudflareCache } from "../src/cache.ts";
import { createRuntimeCloudflareHarness } from "./harness.ts";

runPortContract(blobStoreContract, "Miniflare R2", {
  create: async () => {
    const harness = await createRuntimeCloudflareHarness();
    return { store: createCloudflareBlobStore(harness.bucket), harness };
  },
  dispose: async ({ harness }) => {
    await harness.miniflare.dispose();
  },
});

function cacheFactory() {
  return async () => {
    const harness = await createRuntimeCloudflareHarness();
    let now = 1_000;
    return {
      cache: createCloudflareCache(harness.namespace, { now: () => now }),
      advanceSeconds: (seconds: number) => {
        now += seconds * 1000;
      },
      harness,
    };
  };
}

runPortContract(cacheContract, "Miniflare KV", {
  create: cacheFactory(),
  dispose: async ({ harness }) => {
    await harness.miniflare.dispose();
  },
});

runPortContract(cacheExpiryContract, "Miniflare KV", {
  create: cacheFactory(),
  dispose: async ({ harness }) => {
    await harness.miniflare.dispose();
  },
});

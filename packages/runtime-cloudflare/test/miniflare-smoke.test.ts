import { expect, it } from "vitest";

import { createRuntimeCloudflareHarness } from "./harness.ts";

it("starts a non-persistent Miniflare Worker harness on loopback", async () => {
  const { miniflare } = await createRuntimeCloudflareHarness();
  try {
    const response = await miniflare.dispatchFetch("http://worker.test/");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
  } finally {
    await miniflare.dispose();
  }
});

import { LogRecordSchema } from "@ai-moves/contracts/logging";
import { EntityIdSchema } from "@ai-moves/contracts/primitives";
import { createLogger } from "@ai-moves/kernel/logger";
import { describe, expect, it } from "vitest";

import { createInMemoryBlobStore } from "../src/fakes/blob-store.ts";
import { createFakeClock, FAKE_CLOCK_START } from "../src/fakes/clock.ts";
import { createSequentialIdGen } from "../src/fakes/id-gen.ts";
import { createInMemoryJobBus } from "../src/fakes/job-bus.ts";
import { createStaticSecretProvider } from "../src/fakes/secrets.ts";
import { createRecordingTelemetry } from "../src/fakes/telemetry.ts";

describe("createFakeClock", () => {
  it("starts at a fixed instant and only moves when told", () => {
    const clock = createFakeClock();
    expect(clock.now()).toBe(FAKE_CLOCK_START);
    expect(new Date(clock.now()).toISOString()).toBe("2026-11-20T00:00:00.000Z");
    clock.advance(1500);
    expect(clock.now()).toBe(FAKE_CLOCK_START + 1500);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });
});

describe("createSequentialIdGen", () => {
  it("yields predictable, schema-valid ids", () => {
    const ids = createSequentialIdGen("item");
    expect([ids.next(), ids.next(), ids.next()]).toEqual([
      "item_000001",
      "item_000002",
      "item_000003",
    ]);
    expect(EntityIdSchema.safeParse(createSequentialIdGen().next()).success).toBe(true);
  });
});

describe("createRecordingTelemetry", () => {
  it("captures what the kernel logger writes", () => {
    const telemetry = createRecordingTelemetry();
    const logger = createLogger({ telemetry, clock: createFakeClock(), component: "ingestion" });
    logger.info("tick.start", { trace_id: "trace_1" });
    logger.warn("poll.degraded", { source_id: "src_1" });
    telemetry.count("poll.ok", 2, { source: "hn" });
    telemetry.count("poll.ok", 3);

    expect(telemetry.events()).toEqual(["tick.start", "poll.degraded"]);
    expect(telemetry.total("poll.ok")).toBe(5);
    expect(telemetry.total("missing")).toBe(0);
    for (const record of telemetry.records) {
      expect(LogRecordSchema.safeParse(record).success).toBe(true);
    }
    telemetry.clear();
    expect(telemetry.records).toEqual([]);
    expect(telemetry.counts).toEqual([]);
  });
});

describe("createStaticSecretProvider", () => {
  const secrets = createStaticSecretProvider({ SLACK_WEBHOOK_MAIN: "placeholder-not-a-secret" });

  it("returns the bound placeholder", async () => {
    expect(await secrets.get("SLACK_WEBHOOK_MAIN")).toBe("placeholder-not-a-secret");
  });

  it("rejects an unbound reference, including inherited property names", async () => {
    await expect(secrets.get("GITHUB_TOKEN")).rejects.toMatchObject({
      code: "SECRET_MISSING",
      kind: "permanent",
    });
    await expect(secrets.get("toString")).rejects.toMatchObject({ code: "SECRET_MISSING" });
  });
});

describe("createInMemoryJobBus helpers", () => {
  it("reads jobs per queue in arrival order and drains one queue at a time", async () => {
    const bus = createInMemoryJobBus();
    await bus.enqueueBatch([
      { v: 1, type: "triage", item_id: "item_1", trace_id: "t" },
      { v: 1, type: "deep", item_id: "item_1", trace_id: "t" },
      { v: 1, type: "triage", item_id: "item_2", trace_id: "t" },
    ]);
    expect(bus.jobs("q-triage").map((job) => job.type === "triage" && job.item_id)).toEqual([
      "item_1",
      "item_2",
    ]);
    expect(bus.drain("q-triage")).toHaveLength(2);
    expect(bus.jobs("q-triage")).toEqual([]);
    expect(bus.jobs("q-deep")).toHaveLength(1);
    bus.clear();
    expect(bus.delivered).toEqual([]);
  });
});

describe("createInMemoryBlobStore helpers", () => {
  it("counts distinct blobs and keeps the first content type", async () => {
    const store = createInMemoryBlobStore();
    const ref = await store.put("body", { contentType: "text/plain" });
    await store.put("body", { contentType: "text/html" });
    await store.put("other", { contentType: "application/json" });
    expect(store.size).toBe(2);
    expect(store.contentType(ref.key)).toBe("text/plain");
    expect(store.contentType("sha256/unknown")).toBeUndefined();
  });
});

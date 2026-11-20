import { AppConfigSchema } from "@ai-moves/contracts/config";
import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createD1Storage } from "../src/d1.ts";
import { applyStorageMigrations } from "../src/migrations.ts";

let worker: Miniflare;
let database: D1Database;

beforeAll(async () => {
  worker = new Miniflare({
    host: "127.0.0.1",
    compatibilityDate: "2026-07-30",
    modules: true,
    d1Databases: { DB: "failure-test" },
    outboundService: () => {
      throw new Error("Unexpected outbound Worker request");
    },
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
  });
  database = await worker.getD1Database("DB");
  await applyStorageMigrations(database);
});

afterAll(() => worker.dispose());

it("classifies foreign-key failures as storage unavailable", async () => {
  const storage = createD1Storage(database);
  await expect(
    storage.items.upsertObserved({
      id: "orphan-item",
      source_id: "missing-source",
      external_key: "missing-source:item",
      kind: "changelog",
      url: null,
      title: "Orphan item",
      published_at: null,
      observed_at: 1,
      state: "candidate",
    }),
  ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", kind: "retryable" });
});

it("rolls back the audit if an audited config write fails after the audit insert", async () => {
  const { admin, audit, config } = createD1Storage(database);
  const model = { provider: "fake", model: "fixture", max_output_tokens: 500 };
  const settings = AppConfigSchema.parse({
    models: { triage: model, deep: model, translate: model },
  });
  const change = { id: "publish-failure", actor: "operator", at: 1 };
  await database
    .prepare(`CREATE TRIGGER reject_publish BEFORE INSERT ON config_versions
    BEGIN SELECT RAISE(ABORT, 'injected publish failure'); END`)
    .run();
  try {
    await expect(admin.publishConfig(settings, 0, change)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    expect(await config.getCurrent()).toBeNull();
    expect(await audit.listRecent(10)).toEqual([]);
  } finally {
    await database.prepare("DROP TRIGGER reject_publish").run();
  }
  expect(await admin.publishConfig(settings, 0, change)).toMatchObject({ version: 1 });
  expect(await audit.listRecent(10)).toMatchObject([{ id: change.id, target: "config:1" }]);
});

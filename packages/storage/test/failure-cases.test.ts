import { AppConfigSchema } from "@ai-moves/contracts/config";
import { createLocalD1, type LocalD1 } from "@ai-moves/testing/test/d1";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createD1Storage } from "../src/d1.ts";
import { applyStorageMigrations } from "../src/migrations.ts";

let harness: LocalD1;

beforeAll(async () => {
  harness = await createLocalD1(applyStorageMigrations);
});

afterAll(() => harness?.dispose());

it("classifies foreign-key failures as storage unavailable", async () => {
  const storage = createD1Storage(harness.database);
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
  const { database } = harness;
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

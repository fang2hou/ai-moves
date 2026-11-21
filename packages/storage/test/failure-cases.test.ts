import { AppConfigSchema } from "@ai-moves/contracts/config";
import type { Alert, Delivery } from "@ai-moves/contracts/entities";
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

it("stores code-only delivery errors on insert and transition while reading legacy messages", async () => {
  const { database, dispose } = await createLocalD1(async (db) => {
    await db.batch([
      db.prepare(`CREATE TABLE alerts (
        id TEXT, alert_key TEXT, item_id TEXT, analysis_id TEXT, cluster_id TEXT,
        tier INTEGER, kind TEXT, decision TEXT, decision_reason_json TEXT, created_at INTEGER,
        documents_json TEXT
      )`),
      db.prepare(`CREATE TABLE deliveries (
        id TEXT, alert_id TEXT, destination_id TEXT, idempotency_key TEXT, state TEXT,
        state_updated_at INTEGER, attempts INTEGER, provider_message_id TEXT, last_error_json TEXT,
        next_attempt_at INTEGER, expires_at INTEGER, lang TEXT, dry_run INTEGER,
        suppressed_reason TEXT, created_at INTEGER, live_send_reserved INTEGER DEFAULT 0
      )`),
    ]);
  });
  try {
    const { alerts, deliveries } = createD1Storage(database);
    const diagnostic = {
      code: "UPSTREAM_UNAVAILABLE",
      kind: "retryable",
      message: "benign detail",
    } as const;
    const summary = { ...diagnostic, message: diagnostic.code };
    const alert: Alert = {
      id: "alert",
      alert_key: "a".repeat(64),
      item_id: "item",
      analysis_id: "analysis",
      cluster_id: "cluster",
      tier: 2,
      kind: "new",
      decision: "send",
      decision_reason_json: {
        why_now: "A change",
        blocked_by: [],
        importance: null,
        impact: 2,
        heat_level: null,
        prior: 55,
      },
      created_at: 1,
    };
    const delivery: Delivery = {
      id: "delivery",
      alert_id: alert.id,
      destination_id: "destination",
      idempotency_key: "b".repeat(64),
      state: "sending",
      state_updated_at: 1,
      attempts: 1,
      provider_message_id: null,
      last_error: diagnostic,
      next_attempt_at: null,
      expires_at: 1000,
      lang: "en",
      dry_run: true,
      suppressed_reason: null,
      created_at: 1,
    };
    await alerts.insertWithDeliveries(alert, [delivery], []);
    expect((await deliveries.get(delivery.id))?.last_error).toEqual(summary);
    await database
      .prepare("UPDATE deliveries SET last_error_json = ? WHERE id = ?")
      .bind(JSON.stringify(diagnostic), delivery.id)
      .run();
    expect((await deliveries.get(delivery.id))?.last_error).toEqual(diagnostic);
    expect(
      await deliveries.transition({
        id: delivery.id,
        from: "sending",
        to: "failed_retryable",
        at: 2,
        patch: { last_error: diagnostic },
      }),
    ).toBe(true);
    expect((await deliveries.get(delivery.id))?.last_error).toEqual(summary);
  } finally {
    await dispose();
  }
});

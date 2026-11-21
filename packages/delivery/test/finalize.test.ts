import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import type { Alert, Delivery, Destination } from "@ai-moves/contracts/entities";
import { expect, it } from "vitest";

import { finalizeAlert, planDeliveries } from "../src/finalize.ts";

it("replays canonical IDs and publishes only pending deliveries", async () => {
  const alert: Alert = {
    id: "canonical",
    alert_key: "a".repeat(64),
    item_id: "item",
    analysis_id: "analysis",
    cluster_id: "cluster",
    tier: 2,
    kind: "new",
    decision: "send",
    decision_reason_json: {
      why_now: "Release",
      blocked_by: [],
      importance: null,
      impact: 2,
      heat_level: null,
      prior: null,
    },
    created_at: 100,
  };
  const delivery: Delivery = {
    id: "canonical-delivery",
    alert_id: alert.id,
    destination_id: "destination",
    idempotency_key: "b".repeat(64),
    state: "pending",
    state_updated_at: 100,
    attempts: 0,
    provider_message_id: null,
    last_error: null,
    next_attempt_at: null,
    expires_at: 1000,
    lang: "en",
    dry_run: false,
    suppressed_reason: null,
    created_at: 100,
  };
  const published: string[] = [];
  const result = await finalizeAlert(
    {
      alerts: { insertWithDeliveries: async () => ({ value: alert, created: false }) },
      deliveries: {
        listByAlert: async (id) => {
          expect(id).toBe(alert.id);
          return [delivery, { ...delivery, id: "already-sent", state: "sent" }];
        },
      },
      jobs: {
        enqueueBatch: async (jobs) => {
          published.push(...jobs.map((job) => ("delivery_id" in job ? job.delivery_id : "")));
        },
      },
    },
    { alert: { ...alert, id: "proposed" }, deliveries: [], documents: [], traceId: "trace" },
  );
  expect(result.id).toBe("canonical");
  expect(published).toEqual(["canonical-delivery"]);
  const doc: AlertDoc = {
    v: 1,
    alert_id: alert.id,
    kind: alert.kind,
    item_kind: "hn",
    tier: alert.tier,
    lang: "en",
    source_label: "Example",
    title: { original: "Release", translated: null },
    why_now: "Release",
    summary: "Summary",
    key_points: [],
    engineering_implications: [],
    caveats: [],
    links: { source: "https://example.test", discussion: null, detail: "https://example.test" },
    translation: { machine_translated: false, fell_back_to_english: false },
    generated_at: 100,
  };
  const destination: Destination = {
    id: "destination",
    name: "test",
    purpose: "alerts",
    channel: "slack",
    secret_ref: "WEBHOOK",
    lang: "en",
    enabled: true,
    dry_run: false,
    min_tier: 1,
    daily_budget: 8,
    source_filters: { hn: true, changelog: false },
    quiet_hours: null,
    created_at: 100,
    updated_at: 100,
  };
  const planned = planDeliveries({
    alert,
    documents: [doc],
    destinations: [destination, { ...destination, id: "japanese", lang: "ja" }, destination],
    itemKind: "hn",
    now: 100,
    expiresAt: 1000,
    forceDryRun: false,
    ids: { next: () => "new-delivery" },
  });
  expect(planned.map((row) => row.destination_id)).toEqual(["destination"]);
  expect(planned[0]).toMatchObject({ alert_id: alert.id, lang: "en", state: "pending" });
});

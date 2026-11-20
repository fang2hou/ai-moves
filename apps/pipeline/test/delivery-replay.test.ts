import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import { AppConfigSchema } from "@ai-moves/contracts/config";
import type { Alert, Destination } from "@ai-moves/contracts/entities";
import type { DeliverJob } from "@ai-moves/contracts/messages";
import { executeDelivery } from "@ai-moves/delivery/execute";
import { finalizeAlert, planDeliveries } from "@ai-moves/delivery/finalize";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { createD1Storage, type D1StorageRepositories } from "@ai-moves/storage/d1";
import { applyStorageMigrations } from "@ai-moves/storage/migrations";
import { createLocalD1 } from "@ai-moves/testing/test/d1";
import { expect, it } from "vitest";

const START = 100;
const DESTINATION: Destination = {
  id: "destination",
  name: "destination",
  purpose: "alerts",
  channel: "slack",
  secret_ref: "SYNTHETIC",
  lang: "en",
  enabled: true,
  dry_run: false,
  min_tier: 1,
  daily_budget: 8,
  source_filters: { hn: true, changelog: true },
  quiet_hours: null,
  created_at: START,
  updated_at: START,
};

async function seed(storage: D1StorageRepositories) {
  const model = { provider: "fake", model: "fixture", max_output_tokens: 500 };
  const config = AppConfigSchema.parse({
    models: { triage: model, deep: model, translate: model },
    delivery: { force_dry_run: false, min_interval_minutes: 0 },
    retry: { deliver: { max_attempts: 2, backoff_seconds: [1] } },
  });
  await storage.admin.publishConfig(config, 0, { id: "initial-config", actor: "test", at: START });
  await storage.sources.upsert({
    id: "source",
    key: "github:example/cli",
    kind: "github_repo",
    config_json: {
      kind: "github_repo",
      owner: "example",
      repo: "cli",
      strategy: "release_first",
      changelog_path: "CHANGELOG.md",
    },
    cursor_json: {
      kind: "github_repo",
      releases_etag: null,
      tags_etag: null,
      changelog_sha: null,
      known_versions: [],
    },
    poll_interval_sec: 600,
    next_poll_at: START,
    created_at: START,
    updated_at: START,
  });
  await storage.items.upsertObserved({
    id: "item",
    source_id: "source",
    external_key: "item-key",
    kind: "changelog",
    url: "https://example.test",
    title: "Release",
    published_at: START,
    observed_at: START,
    state: "candidate",
  });
  await storage.analyses.insertIfAbsent({
    id: "analysis",
    item_id: "item",
    stage: "deep",
    input_hash: "a".repeat(64),
    prompt_version: "deep-v1",
    lang: "en",
    model: "fixture",
    config_version: 1,
    status: "pending",
    output_json: null,
    r2_key: null,
    usage_json: null,
    error_code: null,
    created_at: START,
    updated_at: START,
  });
  await storage.destinations.upsert(DESTINATION);
  return config;
}

function alertFixture(id: string, key: string, now: number): Alert {
  return {
    id,
    alert_key: key.repeat(64),
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
    created_at: now,
  };
}

function documentFixture(alert: Alert, summary: string): AlertDoc {
  return {
    v: 1,
    alert_id: alert.id,
    kind: alert.kind,
    item_kind: "changelog",
    tier: alert.tier,
    lang: "en",
    source_label: "Example",
    title: { original: "Release", translated: null },
    why_now: "Release",
    summary,
    key_points: [],
    engineering_implications: [],
    caveats: [],
    links: { source: "https://example.test", discussion: null, detail: "https://example.test" },
    translation: { machine_translated: false, fell_back_to_english: false },
    generated_at: alert.created_at,
  };
}

it("replays canonical D1 work, fences sends, and rechecks retry time and destination", async () => {
  const local = await createLocalD1(applyStorageMigrations);
  try {
    const storage = createD1Storage(local.database);
    const config = await seed(storage);
    let now = START;
    const wakeups: DeliverJob[] = [];
    const finalize = async (alert: Alert, document: AlertDoc, deliveryId: string) =>
      finalizeAlert(
        {
          ...storage,
          jobs: {
            enqueueBatch: async (jobs) => {
              for (const job of jobs) {
                if (job.type !== "deliver") throw new AppError("INPUT_INVALID");
                wakeups.push(job);
              }
            },
          },
        },
        {
          alert,
          documents: [document],
          deliveries: planDeliveries({
            alert,
            documents: [document],
            destinations: [DESTINATION],
            itemKind: "changelog",
            now,
            expiresAt: START + 100_000,
            forceDryRun: config.delivery.force_dry_run,
            ids: { next: () => deliveryId },
          }),
          traceId: "trace",
        },
      );

    const canonical = alertFixture("canonical", "a", now);
    const document = documentFixture(canonical, "Canonical summary");
    expect(await finalize(canonical, document, "delivery")).toEqual(canonical);
    expect(wakeups.splice(0).map((job) => job.delivery_id)).toEqual(["delivery"]);

    const proposed = { ...canonical, id: "proposed" };
    expect(
      await finalize(
        proposed,
        documentFixture(proposed, "Replacement summary"),
        "proposed-delivery",
      ),
    ).toEqual(canonical);
    expect(wakeups.splice(0).map((job) => job.delivery_id)).toEqual(["delivery"]);
    expect(await storage.alerts.getDocument(canonical.id, "en")).toEqual(document);
    expect(await storage.alerts.getDocument(proposed.id, "en")).toBeNull();
    expect(await storage.deliveries.get("proposed-delivery")).toBeNull();

    const sends: AlertDoc[] = [];
    const clock = { now: () => now };
    const inFlight = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ambiguous = {
      ...storage,
      clock,
      notifiers: {
        slack: {
          channel: "slack" as const,
          send: async (_destination: Destination, doc: AlertDoc) => {
            sends.push(doc);
            inFlight.resolve();
            await release.promise;
            throw new AppError("OUTCOME_UNKNOWN");
          },
        },
        discord: {
          channel: "discord" as const,
          send: async () => {
            throw new AppError("FORBIDDEN");
          },
        },
      },
    };
    const first = executeDelivery(ambiguous, "delivery", config);
    const second = executeDelivery(ambiguous, "delivery", config);
    try {
      await Promise.race([inFlight.promise, Promise.all([first, second])]);
      expect(await storage.deliveries.get("delivery")).toMatchObject({
        state: "sending",
        attempts: 1,
      });
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
    expect(await storage.deliveries.get("delivery")).toMatchObject({
      state: "unknown",
      attempts: 1,
      next_attempt_at: null,
    });
    await executeDelivery(ambiguous, "delivery", config);
    expect(sends).toEqual([document]);
    expect(await storage.budgets.get("1970-01-01", "notify:source:changelog")).toMatchObject({
      used: 1,
    });

    const retry = {
      ...ambiguous,
      notifiers: {
        ...ambiguous.notifiers,
        slack: {
          channel: "slack" as const,
          send: async (_destination: Destination, doc: AlertDoc) => {
            sends.push(doc);
            throw new AppError("UPSTREAM_UNAVAILABLE");
          },
        },
      },
    };
    const scheduleRetry = async (alert: Alert, deliveryId: string) => {
      await finalize(alert, documentFixture(alert, alert.id), deliveryId);
      await executeDelivery(retry, deliveryId, config);
      const row = await storage.deliveries.get(deliveryId);
      expect(row).toMatchObject({ state: "failed_retryable", attempts: 1 });
      const retryAt = row?.next_attempt_at;
      if (retryAt === null || retryAt === undefined) throw new AppError("ROW_INVALID");
      expect(retryAt).toBeGreaterThan(now);
      return retryAt;
    };

    const retryAt = await scheduleRetry(alertFixture("retry-alert", "c", now), "retry-delivery");
    now = retryAt - 1;
    await executeDelivery(retry, "retry-delivery", config);
    expect(sends).toHaveLength(2);
    expect(await storage.deliveries.listDue(now, 10)).toEqual([]);
    now = retryAt;
    expect((await storage.deliveries.listDue(now, 10)).map((row) => row.id)).toEqual([
      "retry-delivery",
    ]);
    await executeDelivery(retry, "retry-delivery", config);
    await executeDelivery(retry, "retry-delivery", config);
    expect(sends).toHaveLength(3);
    expect(await storage.deliveries.get("retry-delivery")).toMatchObject({
      state: "failed_permanent",
      attempts: 2,
      last_error: { code: "ATTEMPTS_EXHAUSTED" },
      next_attempt_at: null,
    });

    const disabledRetryAt = await scheduleRetry(
      alertFixture("disabled-alert", "e", now),
      "disabled-delivery",
    );
    expect(
      await storage.admin.patchDestination(
        DESTINATION.id,
        { enabled: false },
        { id: "disable-audit", actor: "test", at: now },
      ),
    ).toBe(true);
    now = disabledRetryAt;
    await executeDelivery(retry, "disabled-delivery", config);
    expect(sends).toHaveLength(4);
    expect(await storage.deliveries.get("disabled-delivery")).toMatchObject({
      state: "suppressed",
      attempts: 1,
      next_attempt_at: null,
      suppressed_reason: "destination_disabled",
    });
  } finally {
    await local.dispose();
  }
});

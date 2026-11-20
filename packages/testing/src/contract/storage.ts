import type {
  Analysis,
  AnalysisKey,
  AuditLogEntry,
  ItemRevision,
  SourceCursor,
} from "@ai-moves/contracts/entities";
import type {
  AlertRepo,
  AnalysisRepo,
  AuditLog,
  BudgetLedger,
  ConfigStore,
  DeliveryRepo,
  DestinationRepo,
  ItemRepo,
  ItemRevisionRepo,
  ItemSnapshotRepo,
  SourceRepo,
} from "@ai-moves/contracts/ports/storage";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { expect } from "vitest";

import { definePortContract } from "./define.ts";
import {
  alertFixture,
  deliveryFixture,
  destinationFixture,
  githubSource,
  HASH_A,
  HASH_B,
  observedItem,
  pendingAnalysis,
  storageConfig,
  STORAGE_TEST_TIME as now,
} from "./storage-fixtures.ts";

export interface StorageRepositoryHarness {
  readonly sources: SourceRepo;
  readonly items: ItemRepo;
  readonly snapshots: ItemSnapshotRepo;
  readonly revisions: ItemRevisionRepo;
  readonly analyses: AnalysisRepo;
  readonly alerts: AlertRepo;
  readonly deliveries: DeliveryRepo;
  readonly destinations: DestinationRepo;
  readonly budgets: BudgetLedger;
  readonly audit: AuditLog;
  readonly config: ConfigStore;
}

interface ItemSeedHarness {
  readonly sources: Pick<SourceRepo, "upsert">;
  readonly items: Pick<ItemRepo, "upsertObserved">;
}

type ItemHarness = Pick<StorageRepositoryHarness, "sources" | "items">;
type AnalysisHarness = ItemHarness & Pick<StorageRepositoryHarness, "config" | "analyses">;

export interface ItemClaimHarness extends ItemSeedHarness {
  readonly items: Pick<ItemRepo, "upsertObserved" | "transition" | "get">;
}

export interface StoredItemRowHarness extends ItemHarness {
  // Store JSON that is syntactically valid but does not match the score schema, bypassing the repo.
  readonly corruptItemScore: (itemId: string) => Promise<void>;
}

async function seedItem({ sources, items }: ItemSeedHarness): Promise<void> {
  await sources.upsert(githubSource);
  await items.upsertObserved(observedItem);
}

async function seedAnalysis(harness: AnalysisHarness): Promise<Analysis> {
  await seedItem(harness);
  const version = await harness.config.publish(storageConfig, "contract-test", now);
  const analysis = { ...pendingAnalysis, config_version: version.version };
  await harness.analyses.insertIfAbsent(analysis);
  return analysis;
}

async function seedAlertContext(
  harness: AnalysisHarness & Pick<StorageRepositoryHarness, "destinations">,
  destinationCount: number,
): Promise<void> {
  await seedAnalysis(harness);
  for (let index = 1; index <= destinationCount; index += 1) {
    await harness.destinations.upsert(destinationFixture(index));
  }
}

export const itemClaimContract = definePortContract<ItemClaimHarness>("Item claim", [
  {
    name: "applies the state, clock and patch of exactly one competing item claim",
    run: async (harness) => {
      await seedItem(harness);
      const { items } = harness;
      const transition = { id: observedItem.id, from: "candidate", to: "triaging" } as const;
      const [first, second] = await Promise.all([
        items.transition({ ...transition, at: now + 1, patch: { attempts: 1 } }),
        items.transition({ ...transition, at: now + 2, patch: { attempts: 2 } }),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(await items.get(transition.id)).toMatchObject({
        state: "triaging",
        state_updated_at: now + (first ? 1 : 2),
        attempts: first ? 1 : 2,
      });
    },
  },
]);

export const storageRepositoryContract = definePortContract<StorageRepositoryHarness>("Storage", [
  ...itemClaimContract.cases,
  {
    name: "preserves a source's poll outcome on key replay and returns only due enabled sources",
    run: async ({ sources }) => {
      const { value: source, created } = await sources.upsert(githubSource);
      expect(created).toBe(true);
      const cursor: SourceCursor = {
        kind: "github_repo",
        releases_etag: '"v1"',
        tags_etag: null,
        changelog_sha: null,
        known_versions: ["v1"],
      };
      await sources.recordPollOutcome(source.id, {
        at: now + 1,
        next_poll_at: now + 10,
        consecutive_failures: 2,
        status: "degraded",
        cursor_json: cursor,
      });
      const replay = await sources.upsert({ ...githubSource, id: "retry_source" });
      expect(replay).toMatchObject({
        created: false,
        value: { id: source.id, consecutive_failures: 2, cursor_json: cursor },
      });
      await sources.upsert({ ...githubSource, id: "disabled", key: "github:example/disabled" });
      await sources.recordPollOutcome("disabled", {
        at: now + 1,
        next_poll_at: now + 2,
        consecutive_failures: 0,
        status: "disabled",
      });
      expect(await sources.listDue(now + 9, 10)).toEqual([]);
      expect((await sources.listDue(now + 10, 10)).map(({ id }) => id)).toEqual([source.id]);
    },
  },
  {
    name: "reuses the item identity and advances only the last observation on key replay",
    run: async ({ sources, items }) => {
      await sources.upsert(githubSource);
      const { value: original, created } = await items.upsertObserved(observedItem);
      expect(created).toBe(true);
      const retry = {
        ...observedItem,
        id: "retry_item",
        state: "tracking",
        title: "New title",
      } as const;
      expect(await items.upsertObserved({ ...retry, observed_at: now + 10 })).toMatchObject({
        created: false,
        value: { id: original.id },
      });
      await items.upsertObserved({ ...retry, observed_at: now + 5 });
      const stored = { ...original, last_seen_at: now + 10 };
      expect(await items.get(original.id)).toEqual(stored);
      expect(await items.getByExternalKey(original.external_key)).toEqual(stored);
      expect(await items.get(retry.id)).toBeNull();
    },
  },
  {
    name: "finds stale items by state update time, excluding the cutoff and respecting the limit",
    run: async (harness) => {
      await seedItem(harness);
      const { items } = harness;
      await items.upsertObserved({ ...observedItem, observed_at: now + 50 });
      await items.upsertObserved({ ...observedItem, id: "item_2", external_key: "second" });
      await items.upsertObserved({
        ...observedItem,
        id: "at_cutoff",
        external_key: "cutoff",
        observed_at: now + 10,
      });
      await items.upsertObserved({
        ...observedItem,
        id: "wrong_state",
        external_key: "other-state",
        state: "tracking",
      });
      const query = { states: ["candidate"], updatedBefore: now + 10, limit: 10 } as const;
      expect((await items.listStale(query)).map(({ id }) => id).toSorted()).toEqual([
        "item_2",
        observedItem.id,
      ]);
      const limited = (await items.listStale({ ...query, limit: 1 })).map(({ id }) => id);
      expect(limited).toHaveLength(1);
      expect([observedItem.id, "item_2"]).toContain(limited[0]);
    },
  },
  {
    name: "deduplicates snapshots by sample time and protects the retention cutoff",
    run: async (harness) => {
      await seedItem(harness);
      const { snapshots } = harness;
      const first = { item_id: observedItem.id, sampled_at: now, rank: 9, points: 12, comments: 1 };
      const next = { ...first, sampled_at: now + 10, rank: 8 };
      expect(await snapshots.insertIfAbsent(first)).toBe(true);
      expect(await snapshots.insertIfAbsent({ ...first, points: 100 })).toBe(false);
      expect(await snapshots.insertIfAbsent(next)).toBe(true);
      expect(
        (await snapshots.listSince(first.item_id, now)).toSorted(
          (left, right) => left.sampled_at - right.sampled_at,
        ),
      ).toEqual([first, next]);
      expect(await snapshots.deleteBefore(next.sampled_at, 1)).toBe(1);
      expect(await snapshots.listSince(first.item_id, now)).toEqual([next]);
    },
  },
  {
    name: "keeps original revision evidence on content-hash replay",
    run: async (harness) => {
      await seedItem(harness);
      const { revisions } = harness;
      const original: ItemRevision = {
        item_id: observedItem.id,
        content_hash: HASH_A,
        origin: "release",
        r2_key: `sha256/${HASH_A}`,
        observed_at: now,
      };
      const next: ItemRevision = {
        ...original,
        content_hash: HASH_B,
        r2_key: `sha256/${HASH_B}`,
        observed_at: now + 1,
      };
      expect(await revisions.insertIfAbsent(original)).toBe(true);
      expect(await revisions.insertIfAbsent({ ...original, origin: "tag" })).toBe(false);
      expect(await revisions.insertIfAbsent(next)).toBe(true);
      const stored = await revisions.listByItem(original.item_id);
      expect(stored).toHaveLength(2);
      expect(stored).toEqual(expect.arrayContaining([original, next]));
    },
  },
  {
    name: "reuses completed analyses by key without aliasing a different language or prompt version",
    run: async (harness) => {
      const initial = await seedAnalysis(harness);
      const { analyses } = harness;
      const key: AnalysisKey = {
        item_id: initial.item_id,
        stage: initial.stage,
        input_hash: initial.input_hash,
        prompt_version: initial.prompt_version,
        lang: initial.lang,
      };
      const output = { impact: 2 };
      const usage = { input_tokens: 20, output_tokens: 5, cost_usd: null };
      await analyses.complete(initial.id, {
        status: "succeeded",
        at: now + 10,
        output_json: output,
        usage_json: usage,
        r2_key: null,
        error_code: null,
      });
      const completed = await analyses.findByKey(key);
      expect(completed).toMatchObject({
        id: initial.id,
        status: "succeeded",
        output_json: output,
        usage_json: usage,
        updated_at: now + 10,
      });
      const replay = await analyses.insertIfAbsent({ ...initial, id: "retry_analysis" });
      expect(replay).toEqual({ created: false, value: completed });
      expect(await analyses.get("retry_analysis")).toBeNull();
      for (const variant of [
        { ...initial, id: "analysis_ja", lang: "ja" },
        { ...initial, id: "analysis_v2", prompt_version: "deep-v2" },
      ] satisfies Analysis[]) {
        expect(await analyses.insertIfAbsent(variant)).toEqual({ created: true, value: variant });
      }
    },
  },
  {
    name: "replays the alert and delivery idempotency keys without rewriting either row",
    run: async (harness) => {
      await seedAlertContext(harness, 1);
      const delivery = deliveryFixture(alertFixture, 1);
      const repeatedDelivery = { ...delivery, id: "duplicate_delivery", attempts: 2 };
      expect(
        await harness.alerts.insertWithDeliveries(alertFixture, [delivery, repeatedDelivery]),
      ).toEqual({
        created: true,
        value: alertFixture,
      });
      const retry = { ...alertFixture, id: "retry_alert", created_at: now + 1 };
      const duplicate = { ...delivery, id: "retry_delivery", alert_id: retry.id };
      expect(await harness.alerts.insertWithDeliveries(retry, [duplicate])).toEqual({
        created: false,
        value: alertFixture,
      });
      expect(await harness.alerts.getByKey(retry.alert_key)).toEqual(alertFixture);
      expect(await harness.alerts.get(retry.id)).toBeNull();
      expect(await harness.deliveries.listByAlert(alertFixture.id)).toEqual([delivery]);
      expect(await harness.deliveries.get("retry_delivery")).toBeNull();
    },
  },
  {
    name: "rolls back the new alert and its earlier delivery when a later delivery insert fails",
    run: async (harness) => {
      await seedAlertContext(harness, 2);
      const existing = deliveryFixture(alertFixture, 1);
      await harness.alerts.insertWithDeliveries(alertFixture, [existing]);
      const next = { ...alertFixture, id: "alert_2", alert_key: HASH_B, kind: "update" } as const;
      const first = deliveryFixture(next, 1);
      const conflicting = { ...deliveryFixture(next, 2), id: existing.id };
      await expect(
        harness.alerts.insertWithDeliveries(next, [first, conflicting]),
      ).rejects.toBeInstanceOf(AppError);
      expect(await harness.alerts.getByKey(next.alert_key)).toBeNull();
      expect(await harness.alerts.get(next.id)).toBeNull();
      expect(await harness.deliveries.get(first.id)).toBeNull();
      expect(await harness.deliveries.listByAlert(next.id)).toEqual([]);
      expect(await harness.deliveries.get(existing.id)).toEqual(existing);
    },
  },
  {
    name: "finds due and stale deliveries and applies exactly one competing delivery claim",
    run: async (harness) => {
      await seedAlertContext(harness, 4);
      const pending = deliveryFixture(alertFixture, 1);
      const retry = deliveryFixture(alertFixture, 2);
      const future = deliveryFixture(alertFixture, 3);
      const sending = deliveryFixture(alertFixture, 4);
      await harness.alerts.insertWithDeliveries(alertFixture, [
        pending,
        { ...retry, state: "failed_retryable" },
        { ...future, next_attempt_at: now + 100, state_updated_at: now + 10 },
        { ...sending, state: "sending" },
      ]);
      const { deliveries } = harness;
      expect((await deliveries.listDue(now + 1, 10)).map(({ id }) => id).toSorted()).toEqual([
        pending.id,
        retry.id,
      ]);
      expect(
        (
          await deliveries.listStale({ states: ["pending"], updatedBefore: now + 10, limit: 10 })
        ).map(({ id }) => id),
      ).toEqual([pending.id]);

      const claim = { id: pending.id, from: "pending", to: "sending" } as const;
      const [first, second] = await Promise.all([
        deliveries.transition({ ...claim, at: now + 1, patch: { attempts: 1 } }),
        deliveries.transition({ ...claim, at: now + 2, patch: { attempts: 2 } }),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(await deliveries.get(pending.id)).toMatchObject({
        state: "sending",
        state_updated_at: now + (first ? 1 : 2),
        attempts: first ? 1 : 2,
      });
    },
  },
  {
    name: "reuses a destination name and persists an explicit enablement change",
    run: async ({ destinations }) => {
      const destination = destinationFixture(1);
      expect(await destinations.upsert(destination)).toMatchObject({ created: true });
      const replay = await destinations.upsert({ ...destination, id: "retry_destination" });
      expect(replay).toMatchObject({ created: false, value: { id: destination.id } });
      expect(await destinations.get("retry_destination")).toBeNull();
      await destinations.setEnabled(destination.id, false, now + 10);
      expect(await destinations.get(destination.id)).toMatchObject({
        enabled: false,
        updated_at: now + 10,
      });
    },
  },
  {
    name: "grants only one concurrent budget request when there is capacity for one",
    run: async ({ budgets }) => {
      const request = { day: "2026-11-20", scope: "ai:deep", amount: 2, limit: 3 };
      const grants = await Promise.all([budgets.tryConsume(request), budgets.tryConsume(request)]);
      expect(grants.filter(({ granted }) => granted)).toHaveLength(1);
      expect(await budgets.get(request.day, request.scope)).toEqual({
        day: request.day,
        scope: request.scope,
        used: 2,
        limit: 3,
      });
      expect(await budgets.get("2026-11-21", request.scope)).toBeNull();
    },
  },
  {
    name: "keeps audit entries append-only and returns the most recent entry first",
    run: async ({ audit }) => {
      const first: AuditLogEntry = {
        id: "audit_1",
        actor: "contract-test",
        action: "config.publish",
        target: "config:1",
        detail_json: { previous: 0 },
        created_at: now,
      };
      const second = { ...first, id: "audit_2", target: "config:2", created_at: now + 2 };
      await audit.append(first);
      await audit.append(second);
      await audit.append({ ...first, detail_json: { previous: 5 }, created_at: now + 1 });
      expect(await audit.listRecent(2)).toEqual([second, first]);
      expect(await audit.listRecent(1)).toEqual([second]);
    },
  },
  {
    name: "publishes a new config version and returns it as current even at the same timestamp",
    run: async ({ config }) => {
      expect(await config.getCurrent()).toBeNull();
      const first = await config.publish(storageConfig, "first-operator", now);
      const changed = { ...storageConfig, ai: { ...storageConfig.ai, enabled: false } };
      const second = await config.publish(changed, "second-operator", now);
      expect(second.version).toBeGreaterThan(first.version);
      expect(await config.getCurrent()).toEqual({
        version: second.version,
        config: changed,
        created_at: now,
        created_by: "second-operator",
      });
    },
  },
]);

export const storedItemRowContract = definePortContract<StoredItemRowHarness>("Stored item row", [
  {
    name: "classifies an invalid stored score as ROW_INVALID instead of returning or hiding the row",
    run: async (harness) => {
      await seedItem(harness);
      await harness.corruptItemScore(observedItem.id);
      await expect(harness.items.get(observedItem.id)).rejects.toMatchObject({
        code: "ROW_INVALID",
        kind: "validation",
      });
    },
  },
]);

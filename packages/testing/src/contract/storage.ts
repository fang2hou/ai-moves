import type {
  Analysis,
  AnalysisKey,
  AuditLogEntry,
  ItemRevision,
  SourceCursor,
} from "@ai-moves/contracts/entities";
import type {
  AdminRepo,
  AlertRepo,
  AnalysisCompletion,
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

import { createInMemoryJobBus } from "../fakes/job-bus.ts";
import { definePortContract } from "./define.ts";
import {
  alertFixture,
  deliveryFixture,
  destinationFixture,
  documentFixture,
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
  readonly admin: AdminRepo;
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
    name: "preserves a source's poll outcome on key replay and schedules only due enabled sources",
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
      await sources.upsert({ ...githubSource, id: "disabled", key: "github:example/disabled" });
      await sources.scheduleDue(now, 1, 10);
      const work = { source_id: source.id, tick_bucket: 1 };
      const disabled = { source_id: "disabled", tick_bucket: 1 };
      const lease = { owner: "first_poll", now, expiresAt: now + 5 };
      await sources.claimPoll(work, lease);
      expect(
        await sources.finishPoll(work, lease.owner, {
          at: now + 1,
          next_poll_at: now + 10,
          consecutive_failures: 2,
          status: "degraded",
          cursor_json: cursor,
        }),
      ).toBe(true);
      const replay = await sources.upsert({ ...githubSource, id: "retry_source" });
      expect(replay).toMatchObject({
        created: false,
        value: { id: source.id, consecutive_failures: 2, cursor_json: cursor },
      });
      await sources.claimPoll(disabled, lease);
      expect(
        await sources.finishPoll(disabled, lease.owner, {
          at: now + 1,
          next_poll_at: now + 2,
          consecutive_failures: 0,
          status: "disabled",
        }),
      ).toBe(true);
      await sources.scheduleDue(now + 9, 2, 10);
      expect(await sources.listReadyPolls(now + 9, 10)).toEqual([]);
      await sources.scheduleDue(now + 10, 2, 10);
      expect(await sources.listReadyPolls(now + 10, 10)).toEqual([{ ...work, tick_bucket: 2 }]);
    },
  },
  {
    name: "recovers lost and partially published poll messages without overwriting a newer owner",
    run: async ({ sources }) => {
      const first = { source_id: githubSource.id, tick_bucket: 1 };
      const second = { source_id: "src_other", tick_bucket: 1 };
      await sources.upsert(githubSource);
      await sources.upsert({ ...githubSource, id: second.source_id, key: "github:example/other" });
      await Promise.all([sources.scheduleDue(now, 1, 2), sources.scheduleDue(now, 1, 2)]);
      const bus = createInMemoryJobBus();
      const publish = async (at: number): Promise<void> => {
        const polls = await sources.listReadyPolls(at, 2);
        await bus.enqueueBatch(
          polls.map((poll) => ({ ...poll, v: 1, type: "poll", trace_id: "fixture_tick" })),
        );
      };
      await sources.scheduleDue(now + 1, 2, 2);
      bus.failSendAfter(1);
      await expect(publish(now + 1)).rejects.toMatchObject({ code: "QUEUE_UNAVAILABLE" });
      expect(bus.jobs("q-poll")).toMatchObject([first]);
      await publish(now + 2);
      expect(bus.drain("q-poll")).toMatchObject([first, first, second]);

      const lease = { owner: "poll_a", now: now + 2, expiresAt: now + 5 };
      const winners = await Promise.all([
        sources.claimPoll(first, lease),
        sources.claimPoll(first, { ...lease, owner: "poll_b" }),
      ]);
      expect(winners.filter(Boolean)).toHaveLength(1);
      const oldOwner = winners[0] === null ? "poll_b" : lease.owner;
      expect(await sources.listReadyPolls(now + 4, 1)).toEqual([second]);
      expect(await sources.listReadyPolls(now + 5, 2)).toEqual([second, first]);
      const nextLease = { owner: "poll_retry", now: now + 5, expiresAt: now + 10 };
      expect(await sources.claimPoll(first, nextLease)).toMatchObject({ id: first.source_id });
      const outcome = {
        at: now + 6,
        next_poll_at: now + 6,
        consecutive_failures: 0,
        status: "active",
      } as const;
      expect(
        await sources.finishPoll(first, oldOwner, { ...outcome, next_poll_at: now + 100 }),
      ).toBe(false);
      expect(await sources.finishPoll(first, nextLease.owner, outcome)).toBe(true);
      await sources.scheduleDue(now + 6, 1, 2);
      expect(await sources.listReadyPolls(now + 6, 2)).toEqual([second]);
      await sources.scheduleDue(now + 6, 2, 2);
      expect(await sources.claimPoll(first, { ...nextLease, now: now + 6 })).toBeNull();
      expect(await sources.listReadyPolls(now + 6, 2)).toEqual([
        second,
        { ...first, tick_bucket: 2 },
      ]);
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
    name: "recovers only due work and rejects a stale item completion after the state is reclaimed",
    run: async (harness) => {
      await seedItem(harness);
      const { items } = harness;
      const id = observedItem.id;
      const leased = { state_updated_at: now + 1, attempts: 1 };
      expect(
        await items.transition({
          id,
          from: "candidate",
          to: "triaging",
          at: leased.state_updated_at,
          patch: { attempts: leased.attempts },
        }),
      ).toBe(true);
      expect(
        await items.transition({
          id,
          from: "triaging",
          to: "candidate",
          at: now + 2,
          expected: leased,
          patch: { next_attempt_at: now + 4 },
        }),
      ).toBe(true);
      const query = { states: ["candidate"] as const, updatedBefore: now + 3, limit: 1 };
      expect(await items.listStale({ ...query, readyAt: now + 3 })).toEqual([]);
      const [retry] = await items.listStale({ ...query, readyAt: now + 4 });
      if (retry === undefined) throw new AppError("NOT_FOUND");
      const reclaimed = { state_updated_at: now + 4, attempts: 2 };
      expect(
        await items.transition({
          id,
          from: "candidate",
          to: "triaging",
          expected: retry,
          at: reclaimed.state_updated_at,
          patch: { attempts: 2 },
        }),
      ).toBe(true);
      expect(
        await items.transition({
          id,
          from: "triaging",
          to: "triaged_reject",
          expected: leased,
          at: now + 5,
        }),
      ).toBe(false);
      expect(
        await items.transition({
          id,
          from: "triaging",
          to: "triaged_pass",
          expected: reclaimed,
          at: now + 5,
        }),
      ).toBe(true);
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
      const lease = { owner: "analysis_worker", now, expiresAt: now + 20 };
      await analyses.claim(initial.id, lease);
      await analyses.complete(initial.id, lease.owner, {
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
    name: "recovers an expired analysis after a committed debit and rejects a late result",
    run: async (harness) => {
      const analysis = await seedAnalysis(harness);
      const { analyses, budgets } = harness;
      const first = { owner: "first_execution", now, expiresAt: now + 3 };
      const competing = { ...first, owner: "competing_execution" };
      const claims = await Promise.all([
        analyses.claim(analysis.id, first),
        analyses.claim(analysis.id, competing),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const owner = claims[0] ? first.owner : competing.owner;
      const debit = { workId: owner, scope: "ai:deep", day: "2026-11-20", amount: 1, limit: 2 };
      expect(await budgets.tryConsume(debit)).toMatchObject({ granted: true });
      const completion = {
        at: now + 3,
        status: "succeeded",
        output_json: { impact: 2 },
        usage_json: null,
        r2_key: null,
        error_code: null,
      } satisfies AnalysisCompletion;
      expect(await analyses.complete(analysis.id, owner, completion)).toBe(false);
      const retry = { owner: "retry_execution", now: now + 3, expiresAt: now + 8 };
      expect(await analyses.claim(analysis.id, retry)).toBe(true);
      const retryDebit = { ...debit, workId: retry.owner };
      const replayedGrants = await Promise.all([
        budgets.tryConsume(retryDebit),
        budgets.tryConsume(retryDebit),
      ]);
      expect(replayedGrants.every(({ granted }) => granted)).toBe(true);
      expect(await budgets.get(debit.day, debit.scope)).toMatchObject({ used: 2 });
      expect(await analyses.complete(analysis.id, owner, { ...completion, at: now + 4 })).toBe(
        false,
      );
      expect(
        await analyses.complete(analysis.id, retry.owner, { ...completion, at: now + 4 }),
      ).toBe(true);
      expect(
        await analyses.claim(analysis.id, { ...retry, now: now + 10, expiresAt: now + 20 }),
      ).toBe(false);
      expect(await analyses.get(analysis.id)).toMatchObject({
        status: "succeeded",
        output_json: { impact: 2 },
      });
    },
  },
  {
    name: "replays the alert and delivery idempotency keys without rewriting either row",
    run: async (harness) => {
      await seedAlertContext(harness, 1);
      const delivery = deliveryFixture(alertFixture, 1);
      const repeatedDelivery = { ...delivery, id: "duplicate_delivery", attempts: 2 };
      const english = documentFixture(alertFixture);
      const japanese = documentFixture(alertFixture, "ja");
      await expect(
        harness.alerts.insertWithDeliveries(alertFixture, [delivery], [japanese]),
      ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
      expect(
        await harness.alerts.insertWithDeliveries(
          alertFixture,
          [delivery, repeatedDelivery],
          [english, japanese],
        ),
      ).toEqual({
        created: true,
        value: alertFixture,
      });
      const retry = { ...alertFixture, id: "retry_alert", created_at: now + 1 };
      const duplicate = { ...delivery, id: "retry_delivery", alert_id: retry.id };
      const updatedDocument = {
        ...documentFixture(retry),
        summary: "This replay must not replace the stored document.",
      };
      expect(
        await harness.alerts.insertWithDeliveries(retry, [duplicate], [updatedDocument]),
      ).toEqual({
        created: false,
        value: alertFixture,
      });
      expect(await harness.alerts.getByKey(retry.alert_key)).toEqual(alertFixture);
      expect(await harness.alerts.get(retry.id)).toBeNull();
      expect(await harness.deliveries.listByAlert(alertFixture.id)).toEqual([delivery]);
      expect(await harness.deliveries.get("retry_delivery")).toBeNull();
      expect(await harness.alerts.getDocument(alertFixture.id, "en")).toEqual(english);
      expect(await harness.alerts.getDocument(alertFixture.id, "ja")).toEqual(japanese);
      expect(await harness.alerts.getDocument(alertFixture.id, "zh-CN")).toBeNull();
    },
  },
  {
    name: "pages visible feed items and alerts with stable time and binary ID ties",
    run: async (harness) => {
      await seedAlertContext(harness, 0);
      const { items, alerts } = harness;
      await items.upsertObserved({
        ...observedItem,
        id: "feed_item",
        external_key: "fixture:feed",
        state: "feed_only",
      });
      await items.upsertObserved({
        ...observedItem,
        id: "Feed_Item",
        external_key: "fixture:alert",
        state: "alerted",
      });
      await items.upsertObserved({
        ...observedItem,
        id: "new_hidden",
        external_key: "fixture:hidden",
        observed_at: now + 1,
      });
      expect((await items.listFeed({ limit: 1 })).map(({ id }) => id)).toEqual(["feed_item"]);
      expect(
        (await items.listFeed({ limit: 2, before: { at: now, id: "feed_item" } })).map(
          ({ id }) => id,
        ),
      ).toEqual(["Feed_Item"]);
      await expect(items.listFeed({ limit: -1 })).rejects.toMatchObject({ code: "INPUT_INVALID" });

      const tied = {
        ...alertFixture,
        id: "Alert_second",
        alert_key: HASH_B,
        item_id: "Feed_Item",
        analysis_id: "analysis_feed",
      };
      await harness.analyses.insertIfAbsent({
        ...pendingAnalysis,
        id: tied.analysis_id,
        item_id: tied.item_id,
      });
      await alerts.insertWithDeliveries(alertFixture, [], []);
      await alerts.insertWithDeliveries(tied, [], []);
      expect(await alerts.listFeed({ limit: 1 })).toEqual([alertFixture]);
      expect(await alerts.listFeed({ limit: 2, before: { at: now, id: alertFixture.id } })).toEqual(
        [tied],
      );
      expect(await alerts.listFeed({ limit: 1, itemId: tied.item_id })).toEqual([tied]);
    },
  },
  {
    name: "rolls back the new alert and its earlier delivery when a later delivery insert fails",
    run: async (harness) => {
      await seedAlertContext(harness, 2);
      const existing = deliveryFixture(alertFixture, 1);
      await harness.alerts.insertWithDeliveries(
        alertFixture,
        [existing],
        [documentFixture(alertFixture)],
      );
      const next = { ...alertFixture, id: "alert_2", alert_key: HASH_B, kind: "update" } as const;
      const first = deliveryFixture(next, 1);
      const conflicting = { ...deliveryFixture(next, 2), id: existing.id };
      await expect(
        harness.alerts.insertWithDeliveries(next, [first, conflicting], [documentFixture(next)]),
      ).rejects.toBeInstanceOf(AppError);
      expect(await harness.alerts.getByKey(next.alert_key)).toBeNull();
      expect(await harness.alerts.get(next.id)).toBeNull();
      expect(await harness.alerts.getDocument(next.id, "en")).toBeNull();
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
      await harness.alerts.insertWithDeliveries(
        alertFixture,
        [
          pending,
          { ...retry, state: "failed_retryable" },
          { ...future, next_attempt_at: now + 100, state_updated_at: now + 10 },
          { ...sending, state: "sending" },
        ],
        [documentFixture(alertFixture)],
      );
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
    run: async ({ admin, destinations }) => {
      const destination = destinationFixture(1);
      expect(await destinations.upsert(destination)).toMatchObject({ created: true });
      const replay = await destinations.upsert({ ...destination, id: "retry_destination" });
      expect(replay).toMatchObject({ created: false, value: { id: destination.id } });
      expect(await destinations.get("retry_destination")).toBeNull();
      await admin.patchDestination(
        destination.id,
        { enabled: false },
        { id: "disable_dest", actor: "operator", at: now + 10 },
      );
      expect(await destinations.get(destination.id)).toMatchObject({
        enabled: false,
        updated_at: now + 10,
      });
    },
  },
  {
    name: "grants only one concurrent budget request when there is capacity for one",
    run: async ({ budgets }) => {
      const request = {
        workId: "first_analysis",
        day: "2026-11-20",
        scope: "ai:deep",
        amount: 2,
        limit: 3,
      };
      const grants = await Promise.all([
        budgets.tryConsume(request),
        budgets.tryConsume({ ...request, workId: "second_analysis" }),
      ]);
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
    name: "replays granted and denied receipts across midnight without creating next day's debit",
    run: async ({ budgets }) => {
      const request = {
        workId: "delivery_1",
        day: "2026-11-20",
        scope: "notify:source:hn",
        amount: 1,
        limit: 1,
      };
      const denied = { ...request, workId: "delivery_2" };
      expect(await budgets.tryConsume(request)).toMatchObject({ granted: true });
      expect(await budgets.tryConsume(denied)).toMatchObject({ granted: false });
      const tomorrow = "2026-11-21";
      expect(await budgets.tryConsume({ ...request, day: tomorrow })).toMatchObject({
        granted: true,
        entry: { day: request.day },
      });
      expect(await budgets.tryConsume({ ...denied, day: tomorrow })).toMatchObject({
        granted: false,
      });
      expect(await budgets.get(tomorrow, request.scope)).toBeNull();
      expect(
        await budgets.tryConsume({ ...request, day: tomorrow, workId: "delivery_3" }),
      ).toMatchObject({ granted: true });
      await expect(budgets.tryConsume({ ...request, amount: 2 })).rejects.toMatchObject({
        code: "STATE_CONFLICT",
      });
    },
  },
  {
    name: "audits only committed admin updates and never reads secret references into admin output",
    run: async ({ admin, audit, config, destinations }) => {
      const destination = destinationFixture(1);
      await destinations.upsert(destination);
      const change = { id: "change_1", actor: "operator", at: now + 1 };
      const patch = { enabled: false, min_tier: 3, quiet_hours: null } as const;
      expect(await admin.patchDestination("missing", patch, change)).toBe(false);
      expect(await audit.listRecent(10)).toEqual([]);
      expect(await admin.patchDestination(destination.id, patch, change)).toBe(true);
      expect(await admin.patchDestination(destination.id, { enabled: true }, change)).toBe(false);
      const listed = await admin.listDestinations();
      expect(listed).toMatchObject([{ id: destination.id, ...patch }]);
      expect(listed[0]).not.toHaveProperty("secret_ref");
      await expect(
        admin.patchDestination(
          destination.id,
          { ...patch, secret_ref: "REJECTED" } as typeof patch,
          change,
        ),
      ).rejects.toMatchObject({ code: "INPUT_INVALID" });

      const updates = await Promise.all([
        admin.publishConfig(storageConfig, 0, { ...change, id: "setting_1" }),
        admin.publishConfig(
          { ...storageConfig, delivery: { ...storageConfig.delivery, paused: true } },
          0,
          { ...change, id: "setting_2" },
        ),
      ]);
      expect(updates.filter(Boolean)).toHaveLength(1);
      expect(await config.getCurrent()).toEqual(updates.find(Boolean));
      expect(await audit.listRecent(10)).toMatchObject([
        {
          action: "config.publish",
          target: "config:1",
          detail_json: { previous: 0 },
          id: updates[0] === null ? "setting_2" : "setting_1",
        },
        {
          action: "destination.patch",
          target: `destination:${destination.id}`,
          detail_json: patch,
          id: change.id,
        },
      ]);
      expect(await admin.publishConfig(storageConfig, 1, change)).toBeNull();
      expect(await config.getCurrent()).toMatchObject({ version: 1 });
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

import type { Item, ItemRevision, ItemSnapshot } from "@ai-news-tracker/contracts/entities";
import {
  FeedQuerySchema,
  type Inserted,
  type ItemPatch,
  type ItemRepo,
  type ItemRevisionRepo,
  type ItemSnapshotRepo,
} from "@ai-news-tracker/contracts/ports/storage";
import type { EntityId, EpochMs } from "@ai-news-tracker/contracts/primitives";
import { parseBoundary } from "@ai-news-tracker/kernel/boundary";
import { AppError } from "@ai-news-tracker/kernel/errors/app-error";
import { compareId, matchesVersion } from "@ai-news-tracker/storage/rules";

import { ABSENT, EXISTS, revCondition } from "./client.ts";
import { readString } from "./codec.ts";
import {
  execute,
  inserted,
  epochsBelow,
  positiveLimit,
  settled,
  requireNoConflict,
  type StorageContext,
} from "./context.ts";
import { indexPartitions, keys, pad, RANGE_END, timeKey, uniqueKey } from "./keys.ts";
import {
  decodeItem,
  decodeRevision,
  decodeSnapshot,
  itemRecord,
  markerRef,
  revisionRecord,
  snapshotRecord,
} from "./records.ts";

function applyItemPatch(item: Item, patch: ItemPatch): Item {
  return {
    ...item,
    ...(patch.content_hash === undefined ? {} : { content_hash: patch.content_hash }),
    ...(patch.revision === undefined ? {} : { revision: patch.revision }),
    ...(patch.score_json === undefined ? {} : { score_json: patch.score_json }),
    ...(patch.tier === undefined ? {} : { tier: patch.tier }),
    ...(patch.cluster_id === undefined ? {} : { cluster_id: patch.cluster_id }),
    ...(patch.attempts === undefined ? {} : { attempts: patch.attempts }),
    ...(patch.next_attempt_at === undefined ? {} : { next_attempt_at: patch.next_attempt_at }),
  };
}

function hasItemPatch(patch: ItemPatch): boolean {
  return Object.values(patch).some((value) => value !== undefined);
}

export function createItemRepos(context: StorageContext) {
  const { table, optimistic, load, read, queryAll, resolveMarker, insertUnique, staleRows } =
    context;

  async function touchItem(id: EntityId, observedAt: EpochMs): Promise<Item> {
    return optimistic(async () => {
      const current = await load(keys.item(id), decodeItem);
      if (current === null) {
        throw new AppError("ROW_INVALID", {
          message: "Unique key marker points at a missing item",
        });
      }
      if (observedAt <= current.value.last_seen_at) return current.value;
      const next: Item = { ...current.value, last_seen_at: observedAt };
      return settled(
        await table.put(itemRecord(next, current.rev + 1), revCondition(current.rev)),
        next,
      );
    });
  }
  const items: ItemRepo = {
    async upsertObserved(observed): Promise<Inserted<Item>> {
      return execute(async () => {
        const marker = await uniqueKey("item_external_key", observed.external_key);
        const existing = await table.get(marker);
        if (existing !== null) {
          return inserted(await touchItem(markerRef(existing), observed.observed_at), false);
        }
        const row: Item = {
          id: observed.id,
          source_id: observed.source_id,
          external_key: observed.external_key,
          kind: observed.kind,
          url: observed.url,
          title: observed.title,
          published_at: observed.published_at,
          content_hash: null,
          revision: 0,
          state: observed.state,
          state_updated_at: observed.observed_at,
          score_json: null,
          tier: null,
          cluster_id: null,
          attempts: 0,
          next_attempt_at: null,
          first_seen_at: observed.observed_at,
          last_seen_at: observed.observed_at,
        };
        const record = itemRecord(row, 1);
        const outcome = await insertUnique(record, marker, observed.id);
        requireNoConflict(outcome, "TransactWriteItems");
        if (outcome.kind === "condition") {
          const replay = await table.get(marker);
          if (replay === null) throw new AppError("STATE_CONFLICT");
          return inserted(await touchItem(markerRef(replay), observed.observed_at), false);
        }
        return inserted(decodeItem(record), true);
      });
    },
    async get(id): Promise<Item | null> {
      return execute(() => read(keys.item(id), decodeItem));
    },
    async getByExternalKey(externalKey): Promise<Item | null> {
      return execute(async () => {
        const marker = await uniqueKey("item_external_key", externalKey);
        return (await resolveMarker(marker, keys.item, decodeItem))?.value ?? null;
      });
    },
    async listFeed(query): Promise<readonly Item[]> {
      const { before, limit } = parseBoundary(FeedQuerySchema, query, "INPUT_INVALID");
      return execute(() =>
        table.collect(
          {
            index: "gsi1",
            partition: indexPartitions.itemFeed,
            descending: true,
            ...(before === undefined
              ? {}
              : { range: { op: "<", value: timeKey(before.at, before.id) } }),
          },
          limit,
          decodeItem,
        ),
      );
    },
    async listBySourceAndStates(sourceId, states, limit): Promise<readonly Item[]> {
      const wanted = positiveLimit(limit);
      if (states.length === 0 || wanted <= 0) return [];
      return execute(async () => {
        const perState = await Promise.all(
          [...new Set(states)].map((state) =>
            table.collect(
              { index: "gsi2", partition: indexPartitions.itemsBySourceState(sourceId, state) },
              wanted,
              decodeItem,
            ),
          ),
        );
        return perState
          .flat()
          .toSorted((left, right) => compareId(left.id, right.id))
          .slice(0, wanted);
      });
    },
    async update(id, patch): Promise<void> {
      if (!hasItemPatch(patch)) return;
      await execute(() =>
        optimistic(async () => {
          const current = await load(keys.item(id), decodeItem);
          if (current === null) return undefined;
          const next = applyItemPatch(current.value, patch);
          return settled(
            await table.put(itemRecord(next, current.rev + 1), revCondition(current.rev)),
            undefined,
          );
        }),
      );
    },
    async transition(transition): Promise<boolean> {
      return execute(() =>
        optimistic(async () => {
          const current = await load(keys.item(transition.id), decodeItem);
          if (
            current === null ||
            current.value.state !== transition.from ||
            !matchesVersion(current.value, transition.expected)
          ) {
            return false;
          }
          const next: Item = {
            ...applyItemPatch(current.value, transition.patch ?? {}),
            state: transition.to,
            state_updated_at: transition.at,
          };
          return settled(
            await table.put(itemRecord(next, current.rev + 1), revCondition(current.rev)),
            true,
          );
        }),
      );
    },
    async listStale(query): Promise<readonly Item[]> {
      return staleRows(query, indexPartitions.itemsByState, decodeItem);
    },
  };
  const snapshots: ItemSnapshotRepo = {
    async insertIfAbsent(snapshot): Promise<boolean> {
      return execute(async () => {
        const outcome = await table.put(snapshotRecord(snapshot), ABSENT);
        requireNoConflict(outcome, "PutItem");
        return outcome.kind === "ok";
      });
    },
    async listSince(itemId, since): Promise<readonly ItemSnapshot[]> {
      const from = Math.max(0, Math.ceil(since));
      if (!(from <= Number.MAX_SAFE_INTEGER)) return [];
      return execute(() =>
        queryAll(
          {
            partition: keys.itemPartition(itemId),
            range: {
              op: "between",
              value: `${keys.snapshotPrefix}${pad(from)}`,
              upper: `${keys.snapshotPrefix}${RANGE_END}`,
            },
          },
          decodeSnapshot,
        ),
      );
    },
    async deleteBefore(cutoff, limit): Promise<number> {
      const wanted = positiveLimit(limit);
      const below = epochsBelow(cutoff);
      if (wanted <= 0 || below === null) return 0;
      return execute(async () => {
        let deleted = 0;
        let start: unknown;
        do {
          const page = await table.queryPage(
            {
              index: "gsi1",
              partition: indexPartitions.snapshots,
              range: { op: "<", value: below },
            },
            wanted - deleted,
            start,
          );
          // The index may still list a row another sweep removed; the condition keeps it uncounted.
          const outcomes = await Promise.all(
            page.items.map((row) =>
              table.delete({ pk: readString(row, "pk"), sk: readString(row, "sk") }, EXISTS),
            ),
          );
          for (const outcome of outcomes) {
            requireNoConflict(outcome, "DeleteItem");
            if (outcome.kind === "ok") deleted += 1;
          }
          start = page.next;
        } while (start !== undefined && deleted < wanted);
        return deleted;
      });
    },
  };
  const revisions: ItemRevisionRepo = {
    async insertIfAbsent(revision): Promise<boolean> {
      return execute(async () => {
        const outcome = await table.put(revisionRecord(revision), ABSENT);
        requireNoConflict(outcome, "PutItem");
        return outcome.kind === "ok";
      });
    },
    async listByItem(itemId): Promise<readonly ItemRevision[]> {
      return execute(async () =>
        (
          await queryAll(
            {
              partition: keys.itemPartition(itemId),
              range: { op: "begins_with", value: keys.revisionPrefix },
            },
            decodeRevision,
          )
        ).toSorted(
          (left, right) =>
            left.observed_at - right.observed_at ||
            compareId(left.content_hash, right.content_hash),
        ),
      );
    },
  };

  return { items, snapshots, revisions };
}

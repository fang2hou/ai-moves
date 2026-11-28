import type { Source } from "@ai-news-tracker/contracts/entities";
import {
  StorageLimitSchema,
  type Inserted,
  type PollWork,
  type SourceRepo,
} from "@ai-news-tracker/contracts/ports/storage";
import { parseBoundary } from "@ai-news-tracker/kernel/boundary";
import { AppError } from "@ai-news-tracker/kernel/errors/app-error";
import { compareId, validateLease } from "@ai-news-tracker/storage/rules";

import { revCondition, type WriteOp } from "./client.ts";
import {
  execute,
  inserted,
  compareCreated,
  settled,
  requireNoConflict,
  type StorageContext,
} from "./context.ts";
import { keys, uniqueKey } from "./keys.ts";
import { decodePoll, decodeSource, loaded, pollRecord, sourceRecord } from "./records.ts";

export function createSourceRepo(context: StorageContext): SourceRepo {
  const { table, optimistic, commit, load, read, queryAll, resolveMarker, insertUnique } = context;

  const sources: SourceRepo = {
    async upsert(source): Promise<Inserted<Source>> {
      return execute(async () => {
        const marker = await uniqueKey("source_key", source.key);
        const existing = await resolveMarker(marker, keys.source, decodeSource);
        if (existing !== null) return inserted(existing.value, false);
        const row: Source = {
          id: source.id,
          key: source.key,
          kind: source.kind,
          config_json: source.config_json,
          poll_interval_sec: source.poll_interval_sec,
          next_poll_at: source.next_poll_at,
          cursor_json: source.cursor_json,
          consecutive_failures: 0,
          status: "active",
          last_success_at: null,
          created_at: source.created_at,
          updated_at: source.updated_at,
        };
        const record = sourceRecord(row, 1);
        const outcome = await insertUnique(record, marker, source.id);
        requireNoConflict(outcome, "TransactWriteItems");
        if (outcome.kind === "condition") {
          const replay = await resolveMarker(marker, keys.source, decodeSource);
          if (replay !== null) return inserted(replay.value, false);
          throw new AppError("STATE_CONFLICT");
        }
        return inserted(decodeSource(record), true);
      });
    },
    async get(id): Promise<Source | null> {
      return execute(() => read(keys.source(id), decodeSource));
    },
    async list(): Promise<readonly Source[]> {
      return execute(async () =>
        (await queryAll({ partition: keys.sourcePartition }, decodeSource)).toSorted(
          compareCreated,
        ),
      );
    },
    async scheduleDue(now, tickBucket, limit): Promise<void> {
      const bounded = parseBoundary(StorageLimitSchema, limit, "INPUT_INVALID");
      await execute(async () => {
        const [sourceRows, pollRows] = await Promise.all([
          queryAll({ partition: keys.sourcePartition }, decodeSource),
          queryAll({ partition: keys.pollPartition }, (row) => loaded(row, decodePoll)),
        ]);
        const polls = new Map(pollRows.map((poll) => [poll.value.source_id, poll]));
        const due = sourceRows
          .filter((source) => {
            const poll = polls.get(source.id)?.value;
            return (
              source.status !== "disabled" &&
              source.next_poll_at <= now &&
              (poll === undefined || (poll.ready_at === null && poll.tick_bucket < tickBucket))
            );
          })
          .toSorted(
            (left, right) => left.next_poll_at - right.next_poll_at || compareId(left.id, right.id),
          )
          .slice(0, bounded);
        // A slot written since the read (a claim, a finish, or another tick) fails its version
        // condition and is skipped, as the single SQL statement would not have selected it.
        await Promise.all(
          due.map((source) => {
            const rev = polls.get(source.id)?.rev ?? null;
            return table.put(
              pollRecord(
                { source_id: source.id, tick_bucket: tickBucket, ready_at: now, owner: null },
                (rev ?? 0) + 1,
              ),
              revCondition(rev),
            );
          }),
        );
      });
    },
    async listReadyPolls(now, limit): Promise<readonly PollWork[]> {
      const bounded = parseBoundary(StorageLimitSchema, limit, "INPUT_INVALID");
      return execute(async () =>
        (await queryAll({ partition: keys.pollPartition }, decodePoll))
          .flatMap((poll) =>
            poll.ready_at !== null && poll.ready_at <= now
              ? [{ ...poll, ready_at: poll.ready_at }]
              : [],
          )
          .toSorted(
            (left, right) =>
              left.ready_at - right.ready_at || compareId(left.source_id, right.source_id),
          )
          .slice(0, bounded)
          .map(({ source_id, tick_bucket }) => ({ source_id, tick_bucket })),
      );
    },
    async claimPoll(work, lease): Promise<Source | null> {
      validateLease(lease);
      return execute(async () => {
        const claimed = await optimistic(async () => {
          const poll = await load(keys.poll(work.source_id), decodePoll);
          if (
            poll === null ||
            poll.value.tick_bucket !== work.tick_bucket ||
            poll.value.ready_at === null ||
            poll.value.ready_at > lease.now
          ) {
            return false;
          }
          const next = { ...poll.value, owner: lease.owner, ready_at: lease.expiresAt };
          return settled(
            await table.put(pollRecord(next, poll.rev + 1), revCondition(poll.rev)),
            true,
          );
        });
        return claimed ? read(keys.source(work.source_id), decodeSource) : null;
      });
    },
    async finishPoll(work, owner, outcome): Promise<boolean> {
      return execute(() =>
        optimistic(async () => {
          const poll = await load(keys.poll(work.source_id), decodePoll);
          if (
            poll === null ||
            poll.value.tick_bucket !== work.tick_bucket ||
            poll.value.owner !== owner ||
            poll.value.ready_at === null ||
            poll.value.ready_at <= outcome.at
          ) {
            return false;
          }
          const released: WriteOp = {
            kind: "put",
            item: pollRecord({ ...poll.value, ready_at: null, owner: null }, poll.rev + 1),
            condition: revCondition(poll.rev),
          };
          const source = await load(keys.source(work.source_id), decodeSource);
          if (source === null) return settled(await commit([released]), false);
          const next: Source = {
            ...source.value,
            next_poll_at: outcome.next_poll_at,
            consecutive_failures: outcome.consecutive_failures,
            status: outcome.status,
            cursor_json: outcome.cursor_json ?? source.value.cursor_json,
            last_success_at: outcome.last_success_at ?? source.value.last_success_at,
            updated_at: outcome.at,
          };
          return settled(
            await table.transact([
              {
                kind: "put",
                item: sourceRecord(next, source.rev + 1),
                condition: revCondition(source.rev),
              },
              released,
            ]),
            true,
          );
        }),
      );
    },
  };

  return sources;
}

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import { AppConfigSchema, type AppConfig } from "@ai-moves/contracts/config";
import type {
  Alert,
  Analysis,
  AnalysisKey,
  AuditLogEntry,
  BudgetLedgerEntry,
  ConfigVersion,
  Delivery,
  Destination,
  Item,
  ItemRevision,
  ItemSnapshot,
  Source,
} from "@ai-moves/contracts/entities";
import type {
  AdminRepo,
  ClaimVersion,
  AlertRepo,
  AnalysisCompletion,
  AnalysisRepo,
  AuditLog,
  BudgetGrant,
  BudgetLedger,
  BudgetRequest,
  ConfigStore,
  DeliveryPatch,
  DeliveryRepo,
  DeliverySendClaim,
  DeliverySendRequest,
  DeliveryTransition,
  DestinationRepo,
  Inserted,
  FeedQuery,
  ItemPatch,
  ItemRepo,
  ItemRevisionRepo,
  ItemSnapshotRepo,
  ItemTransition,
  NewSource,
  PollWork,
  SourceRepo,
} from "@ai-moves/contracts/ports/storage";
import {
  AdminChangeSchema,
  AlertFeedQuerySchema,
  BudgetRequestSchema,
  DestinationPatchSchema,
  FeedQuerySchema,
  StorageLimitSchema,
  type DestinationSummary,
} from "@ai-moves/contracts/ports/storage";
import type { EpochMs } from "@ai-moves/contracts/primitives";
import { isDeliveryTransitionAllowed } from "@ai-moves/contracts/states";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { AppError, summarizeDurableError } from "@ai-moves/kernel/errors/app-error";

import {
  decodeAlert,
  decodeAlertDocuments,
  decodeAnalysis,
  decodeAuditLogEntry,
  decodeBudgetLedgerEntry,
  decodeConfigVersion,
  decodeDelivery,
  decodeDestination,
  decodeDestinationSummary,
  decodeItem,
  decodeItemRevision,
  decodeItemSnapshot,
  decodeSource,
  integer,
  json,
  nullableJson,
} from "./codecs.ts";
import { sendIntervalCutoff, validateAlertDocuments, validateLease } from "./rules.ts";

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

const alertColumns = `id, alert_key, item_id, analysis_id, cluster_id, tier, kind, decision,
  decision_reason_json, created_at`;

export interface D1StorageRepositories {
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

function toStorageError(cause: unknown): AppError {
  if (cause instanceof AppError) return cause;
  return new AppError("STORAGE_UNAVAILABLE", { cause });
}

async function execute<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw toStorageError(cause);
  }
}

function inserted<T>(value: T, created: boolean): Inserted<T> {
  return { value, created };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function buildItemPatch(patch: ItemPatch): { readonly sql: string; readonly values: SqlValue[] } {
  const assignments: string[] = [];
  const values: SqlValue[] = [];
  if (patch.content_hash !== undefined) {
    assignments.push("content_hash = ?");
    values.push(patch.content_hash);
  }
  if (patch.revision !== undefined) {
    assignments.push("revision = ?");
    values.push(patch.revision);
  }
  if (patch.score_json !== undefined) {
    assignments.push("score_json = ?");
    values.push(nullableJson(patch.score_json));
  }
  if (patch.tier !== undefined) {
    assignments.push("tier = ?");
    values.push(patch.tier);
  }
  if (patch.cluster_id !== undefined) {
    assignments.push("cluster_id = ?");
    values.push(patch.cluster_id);
  }
  if (patch.attempts !== undefined) {
    assignments.push("attempts = ?");
    values.push(patch.attempts);
  }
  if (patch.next_attempt_at !== undefined) {
    assignments.push("next_attempt_at = ?");
    values.push(patch.next_attempt_at);
  }
  return { sql: assignments.join(", "), values };
}

function buildDeliveryPatch(patch: DeliveryPatch): {
  readonly sql: string;
  readonly values: SqlValue[];
} {
  const assignments: string[] = [];
  const values: SqlValue[] = [];
  if (patch.attempts !== undefined) {
    assignments.push("attempts = ?");
    values.push(patch.attempts);
  }
  if (patch.provider_message_id !== undefined) {
    assignments.push("provider_message_id = ?");
    values.push(patch.provider_message_id);
  }
  if (patch.last_error !== undefined) {
    assignments.push("last_error_json = ?");
    values.push(
      nullableJson(patch.last_error === null ? null : summarizeDurableError(patch.last_error)),
    );
  }
  if (patch.next_attempt_at !== undefined) {
    assignments.push("next_attempt_at = ?");
    values.push(patch.next_attempt_at);
  }
  if (patch.suppressed_reason !== undefined) {
    assignments.push("suppressed_reason = ?");
    values.push(patch.suppressed_reason);
  }
  return { sql: assignments.join(", "), values };
}

function analysisKeyWhere(key: AnalysisKey): readonly SqlValue[] {
  return [key.item_id, key.stage, key.input_hash, key.prompt_version, key.lang];
}

function cursorValues(before: FeedQuery["before"]): SqlValue[] {
  return before === undefined ? [] : [before.at, before.id];
}

function versionWhere(expected: ClaimVersion | undefined): string {
  return expected === undefined ? "" : "AND state_updated_at = ? AND attempts = ?";
}

function versionValues(expected: ClaimVersion | undefined): SqlValue[] {
  return expected === undefined ? [] : [expected.state_updated_at, expected.attempts];
}

function readyWhere(readyAt: EpochMs | undefined): string {
  return readyAt === undefined ? "" : "AND (next_attempt_at IS NULL OR next_attempt_at <= ?)";
}

export function createD1Storage(database: D1Database): D1StorageRepositories {
  async function first<T>(
    statement: string,
    values: readonly SqlValue[],
    decode: (row: Row) => T,
  ): Promise<T | null> {
    const row = await database
      .prepare(statement)
      .bind(...values)
      .first<Row>();
    return row === null ? null : decode(row);
  }

  async function all<T>(
    statement: string,
    values: readonly SqlValue[],
    decode: (row: Row) => T,
  ): Promise<readonly T[]> {
    const result = await database
      .prepare(statement)
      .bind(...values)
      .all<Row>();
    return result.results.map(decode);
  }

  const sources: SourceRepo = {
    async upsert(source: NewSource): Promise<Inserted<Source>> {
      return execute(async () => {
        const existing = await first<Source>(
          "SELECT * FROM sources WHERE key = ?",
          [source.key],
          decodeSource,
        );
        if (existing !== null) return inserted(existing, false);
        const result = await database
          .prepare(`INSERT INTO sources (
            id, key, kind, config_json, poll_interval_sec, next_poll_at, cursor_json,
            consecutive_failures, status, last_success_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', NULL, ?, ?) ON CONFLICT DO NOTHING`)
          .bind(
            source.id,
            source.key,
            source.kind,
            json(source.config_json),
            source.poll_interval_sec,
            source.next_poll_at,
            json(source.cursor_json),
            source.created_at,
            source.updated_at,
          )
          .run();
        if (result.meta.changes === 0) {
          const replay = await first<Source>(
            "SELECT * FROM sources WHERE key = ?",
            [source.key],
            decodeSource,
          );
          if (replay !== null) return inserted(replay, false);
          throw new AppError("STATE_CONFLICT");
        }
        const row = await first<Source>(
          "SELECT * FROM sources WHERE id = ?",
          [source.id],
          decodeSource,
        );
        if (row === null) throw new AppError("STORAGE_UNAVAILABLE");
        return inserted(row, true);
      });
    },
    async get(id): Promise<Source | null> {
      return execute(() => first("SELECT * FROM sources WHERE id = ?", [id], decodeSource));
    },
    async list(): Promise<readonly Source[]> {
      return execute(() => all("SELECT * FROM sources ORDER BY created_at, id", [], decodeSource));
    },
    async scheduleDue(now, tickBucket, limit): Promise<void> {
      const bounded = parseBoundary(StorageLimitSchema, limit, "INPUT_INVALID");
      await execute(async () => {
        await database
          .prepare(`INSERT INTO source_polls (source_id, tick_bucket, ready_at, owner)
          SELECT s.id, ?, ?, NULL FROM sources s LEFT JOIN source_polls p ON p.source_id = s.id
          WHERE s.status != 'disabled' AND s.next_poll_at <= ?
            AND (p.source_id IS NULL OR (p.ready_at IS NULL AND p.tick_bucket < ?))
          ORDER BY s.next_poll_at, s.id LIMIT ?
          ON CONFLICT(source_id) DO UPDATE SET tick_bucket = excluded.tick_bucket,
            ready_at = excluded.ready_at, owner = NULL`)
          .bind(tickBucket, now, now, tickBucket, bounded)
          .run();
      });
    },
    async listReadyPolls(now, limit): Promise<readonly PollWork[]> {
      const bounded = parseBoundary(StorageLimitSchema, limit, "INPUT_INVALID");
      return execute(async () => {
        const { results } = await database
          .prepare(`SELECT source_id, tick_bucket FROM source_polls
          WHERE ready_at <= ? ORDER BY ready_at, source_id LIMIT ?`)
          .bind(now, bounded)
          .all<PollWork>();
        return results;
      });
    },
    async claimPoll(work, lease): Promise<Source | null> {
      validateLease(lease);
      return execute(async () => {
        const [claim, read] = await database.batch<Row>([
          database
            .prepare(`UPDATE source_polls SET owner = ?, ready_at = ?
            WHERE source_id = ? AND tick_bucket = ? AND ready_at <= ?`)
            .bind(lease.owner, lease.expiresAt, work.source_id, work.tick_bucket, lease.now),
          database.prepare("SELECT * FROM sources WHERE id = ?").bind(work.source_id),
        ]);
        const row = read?.results[0];
        return claim?.meta.changes === 1 && row !== undefined ? decodeSource(row) : null;
      });
    },
    async finishPoll(work, owner, outcome): Promise<boolean> {
      return execute(async () => {
        const [result] = await database.batch([
          database
            .prepare(`UPDATE sources SET next_poll_at = ?, consecutive_failures = ?, status = ?,
            cursor_json = COALESCE(?, cursor_json), last_success_at = COALESCE(?, last_success_at), updated_at = ?
            WHERE id = ? AND EXISTS (
              SELECT 1 FROM source_polls WHERE source_id = sources.id AND tick_bucket = ?
                AND owner = ? AND ready_at > ?
            )`)
            .bind(
              outcome.next_poll_at,
              outcome.consecutive_failures,
              outcome.status,
              outcome.cursor_json === undefined ? null : json(outcome.cursor_json),
              outcome.last_success_at ?? null,
              outcome.at,
              work.source_id,
              work.tick_bucket,
              owner,
              outcome.at,
            ),
          database
            .prepare(`UPDATE source_polls SET ready_at = NULL, owner = NULL
            WHERE source_id = ? AND tick_bucket = ? AND owner = ? AND ready_at > ?`)
            .bind(work.source_id, work.tick_bucket, owner, outcome.at),
        ]);
        return result?.meta.changes === 1;
      });
    },
  };

  const items: ItemRepo = {
    async upsertObserved(observed): Promise<Inserted<Item>> {
      return execute(async () => {
        const existing = await first<Item>(
          "SELECT * FROM items WHERE external_key = ?",
          [observed.external_key],
          decodeItem,
        );
        if (existing !== null) {
          await database
            .prepare("UPDATE items SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?")
            .bind(observed.observed_at, existing.id, observed.observed_at)
            .run();
          const row = await first<Item>(
            "SELECT * FROM items WHERE id = ?",
            [existing.id],
            decodeItem,
          );
          if (row === null) throw new AppError("STORAGE_UNAVAILABLE");
          return inserted(row, false);
        }
        const result = await database
          .prepare(`INSERT INTO items (
            id, source_id, external_key, kind, url, title, published_at, content_hash, revision,
            state, state_updated_at, score_json, tier, cluster_id, attempts, next_attempt_at,
            first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?)
          ON CONFLICT DO NOTHING`)
          .bind(
            observed.id,
            observed.source_id,
            observed.external_key,
            observed.kind,
            observed.url,
            observed.title,
            observed.published_at,
            observed.state,
            observed.observed_at,
            observed.observed_at,
            observed.observed_at,
          )
          .run();
        if (result.meta.changes === 0) {
          const replay = await first<Item>(
            "SELECT * FROM items WHERE external_key = ?",
            [observed.external_key],
            decodeItem,
          );
          if (replay !== null) {
            await database
              .prepare("UPDATE items SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?")
              .bind(observed.observed_at, replay.id, observed.observed_at)
              .run();
            const current = await first<Item>(
              "SELECT * FROM items WHERE id = ?",
              [replay.id],
              decodeItem,
            );
            if (current === null) throw new AppError("STORAGE_UNAVAILABLE");
            return inserted(current, false);
          }
          throw new AppError("STATE_CONFLICT");
        }
        const row = await first<Item>(
          "SELECT * FROM items WHERE id = ?",
          [observed.id],
          decodeItem,
        );
        if (row === null) throw new AppError("STORAGE_UNAVAILABLE");
        return inserted(row, true);
      });
    },
    async get(id): Promise<Item | null> {
      return execute(() => first("SELECT * FROM items WHERE id = ?", [id], decodeItem));
    },
    async getByExternalKey(externalKey): Promise<Item | null> {
      return execute(() =>
        first("SELECT * FROM items WHERE external_key = ?", [externalKey], decodeItem),
      );
    },
    async listFeed(query): Promise<readonly Item[]> {
      const { before, limit } = parseBoundary(FeedQuerySchema, query, "INPUT_INVALID");
      const cursor = before === undefined ? "" : "AND (first_seen_at, id) < (?, ?)";
      return execute(() =>
        all(
          `SELECT * FROM items WHERE state IN ('alerted', 'feed_only') ${cursor}
          ORDER BY first_seen_at DESC, id DESC LIMIT ?`,
          [...cursorValues(before), limit],
          decodeItem,
        ),
      );
    },
    async listBySourceAndStates(sourceId, states, limit): Promise<readonly Item[]> {
      if (states.length === 0) return [];
      return execute(() =>
        all(
          `SELECT * FROM items WHERE source_id = ? AND state IN (${placeholders(states.length)}) ORDER BY id LIMIT ?`,
          [sourceId, ...states, limit],
          decodeItem,
        ),
      );
    },
    async update(id, patch): Promise<void> {
      const { sql, values } = buildItemPatch(patch);
      if (sql.length === 0) return;
      await execute(async () => {
        await database
          .prepare(`UPDATE items SET ${sql} WHERE id = ?`)
          .bind(...values, id)
          .run();
      });
    },
    async transition(transition: ItemTransition): Promise<boolean> {
      return execute(async () => {
        const patch = buildItemPatch(transition.patch ?? {});
        const prefix = patch.sql.length === 0 ? "" : `${patch.sql}, `;
        const result = await database
          .prepare(
            `UPDATE items SET ${prefix}state = ?, state_updated_at = ? WHERE id = ? AND state = ?
              ${versionWhere(transition.expected)}`,
          )
          .bind(
            ...patch.values,
            transition.to,
            transition.at,
            transition.id,
            transition.from,
            ...versionValues(transition.expected),
          )
          .run();
        return result.meta.changes === 1;
      });
    },
    async listStale(query): Promise<readonly Item[]> {
      const bounded = parseBoundary(StorageLimitSchema, query.limit, "INPUT_INVALID");
      if (query.states.length === 0) return [];
      return execute(() =>
        all(
          `SELECT * FROM items WHERE state IN (${placeholders(query.states.length)}) AND state_updated_at < ?
           ${readyWhere(query.readyAt)} ORDER BY state_updated_at, id LIMIT ?`,
          [
            ...query.states,
            query.updatedBefore,
            ...(query.readyAt === undefined ? [] : [query.readyAt]),
            bounded,
          ],
          decodeItem,
        ),
      );
    },
  };

  const snapshots: ItemSnapshotRepo = {
    async insertIfAbsent(snapshot): Promise<boolean> {
      return execute(async () => {
        const result = await database
          .prepare(
            "INSERT OR IGNORE INTO item_snapshots (item_id, sampled_at, rank, points, comments) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            snapshot.item_id,
            snapshot.sampled_at,
            snapshot.rank,
            snapshot.points,
            snapshot.comments,
          )
          .run();
        return result.meta.changes === 1;
      });
    },
    async listSince(itemId, since): Promise<readonly ItemSnapshot[]> {
      return execute(() =>
        all(
          "SELECT * FROM item_snapshots WHERE item_id = ? AND sampled_at >= ? ORDER BY sampled_at",
          [itemId, since],
          decodeItemSnapshot,
        ),
      );
    },
    async deleteBefore(cutoff, limit): Promise<number> {
      return execute(async () => {
        const result = await database
          .prepare(`DELETE FROM item_snapshots WHERE rowid IN (
            SELECT rowid FROM item_snapshots WHERE sampled_at < ? ORDER BY sampled_at, rowid LIMIT ?
          )`)
          .bind(cutoff, limit)
          .run();
        return result.meta.changes;
      });
    },
  };

  const revisions: ItemRevisionRepo = {
    async insertIfAbsent(revision): Promise<boolean> {
      return execute(async () => {
        const result = await database
          .prepare(
            "INSERT OR IGNORE INTO item_revisions (item_id, content_hash, origin, r2_key, observed_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            revision.item_id,
            revision.content_hash,
            revision.origin,
            revision.r2_key,
            revision.observed_at,
          )
          .run();
        return result.meta.changes === 1;
      });
    },
    async listByItem(itemId): Promise<readonly ItemRevision[]> {
      return execute(() =>
        all(
          "SELECT * FROM item_revisions WHERE item_id = ? ORDER BY observed_at, content_hash",
          [itemId],
          decodeItemRevision,
        ),
      );
    },
  };

  const analyses: AnalysisRepo = {
    async insertIfAbsent(analysis): Promise<Inserted<Analysis>> {
      return execute(async () => {
        const existing = await first<Analysis>(
          `SELECT * FROM analyses WHERE item_id = ? AND stage = ? AND input_hash = ?
           AND prompt_version = ? AND lang = ?`,
          analysisKeyWhere(analysis),
          decodeAnalysis,
        );
        if (existing !== null) return inserted(existing, false);
        const result = await database
          .prepare(`INSERT INTO analyses (
            id, item_id, stage, input_hash, prompt_version, lang, model, config_version,
            status, output_json, r2_key, usage_json, error_code, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .bind(
            analysis.id,
            analysis.item_id,
            analysis.stage,
            analysis.input_hash,
            analysis.prompt_version,
            analysis.lang,
            analysis.model,
            analysis.config_version,
            analysis.status,
            nullableJson(analysis.output_json),
            analysis.r2_key,
            nullableJson(analysis.usage_json),
            analysis.error_code,
            analysis.created_at,
            analysis.updated_at,
          )
          .run();
        if (result.meta.changes === 0) {
          const replay = await first<Analysis>(
            `SELECT * FROM analyses WHERE item_id = ? AND stage = ? AND input_hash = ?
             AND prompt_version = ? AND lang = ?`,
            analysisKeyWhere(analysis),
            decodeAnalysis,
          );
          if (replay !== null) return inserted(replay, false);
          throw new AppError("STATE_CONFLICT");
        }
        return inserted(analysis, true);
      });
    },
    async get(id): Promise<Analysis | null> {
      return execute(() => first("SELECT * FROM analyses WHERE id = ?", [id], decodeAnalysis));
    },
    async findByKey(key): Promise<Analysis | null> {
      return execute(() =>
        first(
          `SELECT * FROM analyses WHERE item_id = ? AND stage = ? AND input_hash = ?
           AND prompt_version = ? AND lang = ?`,
          analysisKeyWhere(key),
          decodeAnalysis,
        ),
      );
    },
    async claim(id, lease): Promise<boolean> {
      validateLease(lease);
      return execute(async () => {
        const result = await database
          .prepare(`UPDATE analyses SET lease_owner = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
          .bind(lease.owner, lease.expiresAt, id, lease.now)
          .run();
        return result.meta.changes === 1;
      });
    },
    async complete(id, owner, completion: AnalysisCompletion): Promise<boolean> {
      return execute(async () => {
        const result = await database
          .prepare(`UPDATE analyses SET status = ?, output_json = ?, r2_key = ?, usage_json = ?,
            error_code = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
            WHERE id = ? AND status = 'pending' AND lease_owner = ? AND lease_expires_at > ?`)
          .bind(
            completion.status,
            nullableJson(completion.output_json),
            completion.r2_key,
            nullableJson(completion.usage_json),
            completion.error_code,
            completion.at,
            id,
            owner,
            completion.at,
          )
          .run();
        return result.meta.changes === 1;
      });
    },
  };

  const alerts: AlertRepo = {
    async insertWithDeliveries(alert, deliveriesToInsert, documents): Promise<Inserted<Alert>> {
      return execute(async () => {
        const existing = await first<Alert>(
          `SELECT ${alertColumns} FROM alerts WHERE alert_key = ?`,
          [alert.alert_key],
          decodeAlert,
        );
        if (existing !== null) return inserted(existing, false);
        const validatedDocuments = validateAlertDocuments(alert, deliveriesToInsert, documents);

        const statements: D1PreparedStatement[] = [
          database
            .prepare(`INSERT INTO alerts (
              id, alert_key, item_id, analysis_id, cluster_id, tier, kind, decision,
              decision_reason_json, created_at, documents_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(
              alert.id,
              alert.alert_key,
              alert.item_id,
              alert.analysis_id,
              alert.cluster_id,
              alert.tier,
              alert.kind,
              alert.decision,
              json(alert.decision_reason_json),
              alert.created_at,
              json(validatedDocuments),
            ),
        ];
        const idempotencyKeys = new Set<string>();
        const deliveryIds = new Set<string>();
        for (const delivery of deliveriesToInsert) {
          if (delivery.alert_id !== alert.id) throw new AppError("STATE_CONFLICT");
          if (idempotencyKeys.has(delivery.idempotency_key)) continue;
          if (deliveryIds.has(delivery.id)) throw new AppError("STATE_CONFLICT");
          idempotencyKeys.add(delivery.idempotency_key);
          deliveryIds.add(delivery.id);
          statements.push(
            database
              .prepare(`INSERT INTO deliveries (
                id, alert_id, destination_id, idempotency_key, state, state_updated_at, attempts,
                provider_message_id, last_error_json, next_attempt_at, expires_at, lang, dry_run,
                suppressed_reason, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .bind(
                delivery.id,
                delivery.alert_id,
                delivery.destination_id,
                delivery.idempotency_key,
                delivery.state,
                delivery.state_updated_at,
                delivery.attempts,
                delivery.provider_message_id,
                nullableJson(
                  delivery.last_error === null ? null : summarizeDurableError(delivery.last_error),
                ),
                delivery.next_attempt_at,
                delivery.expires_at,
                delivery.lang,
                integer(delivery.dry_run),
                delivery.suppressed_reason,
                delivery.created_at,
              ),
          );
        }
        try {
          await database.batch(statements);
        } catch (cause) {
          const replay = await first<Alert>(
            `SELECT ${alertColumns} FROM alerts WHERE alert_key = ?`,
            [alert.alert_key],
            decodeAlert,
          );
          if (replay !== null) return inserted(replay, false);
          throw cause;
        }
        return inserted(alert, true);
      });
    },
    async get(id): Promise<Alert | null> {
      return execute(() =>
        first(`SELECT ${alertColumns} FROM alerts WHERE id = ?`, [id], decodeAlert),
      );
    },
    async getByKey(alertKey): Promise<Alert | null> {
      return execute(() =>
        first(`SELECT ${alertColumns} FROM alerts WHERE alert_key = ?`, [alertKey], decodeAlert),
      );
    },
    async getDocument(id, lang): Promise<AlertDoc | null> {
      const documents = await execute(() =>
        first("SELECT documents_json FROM alerts WHERE id = ?", [id], decodeAlertDocuments),
      );
      return documents?.find((document) => document.lang === lang) ?? null;
    },
    async listFeed(query): Promise<readonly Alert[]> {
      const { before, limit, itemId } = parseBoundary(AlertFeedQuerySchema, query, "INPUT_INVALID");
      const cursor = before === undefined ? "" : "AND (created_at, id) < (?, ?)";
      const item = itemId === undefined ? "" : "AND item_id = ?";
      return execute(() =>
        all(
          `SELECT ${alertColumns} FROM alerts WHERE 1 = 1 ${item} ${cursor}
          ORDER BY created_at DESC, id DESC LIMIT ?`,
          [...(itemId === undefined ? [] : [itemId]), ...cursorValues(before), limit],
          decodeAlert,
        ),
      );
    },
  };

  const deliveries: DeliveryRepo = {
    async get(id): Promise<Delivery | null> {
      return execute(() => first("SELECT * FROM deliveries WHERE id = ?", [id], decodeDelivery));
    },
    async listByAlert(alertId): Promise<readonly Delivery[]> {
      return execute(() =>
        all("SELECT * FROM deliveries WHERE alert_id = ? ORDER BY id", [alertId], decodeDelivery),
      );
    },
    async claimForSend(request: DeliverySendRequest): Promise<DeliverySendClaim> {
      const cutoff = sendIntervalCutoff(request);
      const { id, from, expected, at, maxUpdatesPerItem } = request;
      return execute(async () => {
        const claimed = await first(
          `WITH policy AS (
            SELECT d.id, CASE
              WHEN a.kind = 'update' AND (
                SELECT COUNT(DISTINCT predecessor.id) FROM alerts predecessor
                JOIN deliveries history ON history.alert_id = predecessor.id
                WHERE predecessor.item_id = a.item_id AND predecessor.kind = 'update'
                  AND predecessor.id != a.id AND history.live_send_reserved = 1
              ) >= ? THEN 'update_limit'
              WHEN ? IS NOT NULL AND (
                EXISTS (
                  SELECT 1 FROM deliveries history WHERE history.live_send_reserved = 1
                    AND history.state = 'sending' AND history.alert_id != a.id
                ) OR EXISTS (
                  SELECT 1 FROM deliveries history WHERE history.live_send_reserved = 1
                    AND history.state IN ('sent', 'unknown') AND history.state_updated_at > ?
                    AND history.alert_id != a.id
                )
              ) THEN 'rate_limit'
              ELSE NULL END AS reason
            FROM deliveries d JOIN alerts a ON a.id = d.alert_id
            WHERE d.id = ? AND d.state = ? AND d.state IN ('pending', 'failed_retryable')
              AND d.state_updated_at = ? AND d.attempts = ?
              AND d.dry_run = 0 AND d.expires_at > ? AND d.state_updated_at <= ?
              AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
          )
          UPDATE deliveries AS target SET
            state = CASE WHEN policy.reason IS NULL THEN 'sending' ELSE 'suppressed' END,
            state_updated_at = ?, suppressed_reason = policy.reason, next_attempt_at = NULL,
            attempts = target.attempts + CASE WHEN policy.reason IS NULL THEN 1 ELSE 0 END,
            live_send_reserved = CASE WHEN policy.reason IS NULL THEN 1 ELSE 0 END
          FROM policy WHERE target.id = policy.id RETURNING *`,
          [
            maxUpdatesPerItem,
            cutoff,
            cutoff,
            id,
            from,
            expected.state_updated_at,
            expected.attempts,
            at,
            at,
            at,
            at,
          ],
          decodeDelivery,
        );
        if (claimed === null) return { kind: "unavailable" };
        if (claimed.state === "sending") return { kind: "claimed", delivery: claimed };
        const reason = claimed.suppressed_reason;
        if (reason === "update_limit" || reason === "rate_limit")
          return { kind: "suppressed", reason };
        throw new AppError("ROW_INVALID");
      });
    },
    async transition(transition: DeliveryTransition): Promise<boolean> {
      if (!isDeliveryTransitionAllowed(transition.from, transition.to)) return false;
      return execute(async () => {
        const patch = buildDeliveryPatch(transition.patch ?? {});
        const prefix = patch.sql.length === 0 ? "" : `${patch.sql}, `;
        const release =
          transition.to === "sent" || transition.to === "unknown" ? "" : ", live_send_reserved = 0";
        const result = await database
          .prepare(
            `UPDATE deliveries SET ${prefix}state = ?, state_updated_at = ?${release} WHERE id = ? AND state = ?
              ${versionWhere(transition.expected)}`,
          )
          .bind(
            ...patch.values,
            transition.to,
            transition.at,
            transition.id,
            transition.from,
            ...versionValues(transition.expected),
          )
          .run();
        return result.meta.changes === 1;
      });
    },
    async listDue(now, limit): Promise<readonly Delivery[]> {
      return execute(() =>
        all(
          `SELECT * FROM deliveries
           WHERE state IN ('pending', 'failed_retryable') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY COALESCE(next_attempt_at, 0), id LIMIT ?`,
          [now, limit],
          decodeDelivery,
        ),
      );
    },
    async listStale(query): Promise<readonly Delivery[]> {
      const bounded = parseBoundary(StorageLimitSchema, query.limit, "INPUT_INVALID");
      if (query.states.length === 0) return [];
      return execute(() =>
        all(
          `SELECT * FROM deliveries WHERE state IN (${placeholders(query.states.length)})
           AND state_updated_at < ? ${readyWhere(query.readyAt)} ORDER BY state_updated_at, id LIMIT ?`,
          [
            ...query.states,
            query.updatedBefore,
            ...(query.readyAt === undefined ? [] : [query.readyAt]),
            bounded,
          ],
          decodeDelivery,
        ),
      );
    },
  };

  const destinations: DestinationRepo = {
    async upsert(destination): Promise<Inserted<Destination>> {
      return execute(async () => {
        const existing = await first<Destination>(
          "SELECT * FROM destinations WHERE name = ?",
          [destination.name],
          decodeDestination,
        );
        if (existing !== null) return inserted(existing, false);
        const result = await database
          .prepare(`INSERT INTO destinations (
            id, name, purpose, channel, secret_ref, lang, enabled, dry_run, min_tier,
            daily_budget, source_filters_json, quiet_hours_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .bind(
            destination.id,
            destination.name,
            destination.purpose,
            destination.channel,
            destination.secret_ref,
            destination.lang,
            integer(destination.enabled),
            integer(destination.dry_run),
            destination.min_tier,
            destination.daily_budget,
            json(destination.source_filters),
            nullableJson(destination.quiet_hours),
            destination.created_at,
            destination.updated_at,
          )
          .run();
        if (result.meta.changes === 0) {
          const replay = await first<Destination>(
            "SELECT * FROM destinations WHERE name = ?",
            [destination.name],
            decodeDestination,
          );
          if (replay !== null) return inserted(replay, false);
          throw new AppError("STATE_CONFLICT");
        }
        return inserted(destination, true);
      });
    },
    async get(id): Promise<Destination | null> {
      return execute(() =>
        first("SELECT * FROM destinations WHERE id = ?", [id], decodeDestination),
      );
    },
    async list(): Promise<readonly Destination[]> {
      return execute(() =>
        all("SELECT * FROM destinations ORDER BY created_at, id", [], decodeDestination),
      );
    },
  };

  const budgets: BudgetLedger = {
    async tryConsume(request: BudgetRequest): Promise<BudgetGrant> {
      parseBoundary(BudgetRequestSchema, request, "INPUT_INVALID");
      return execute(async () => {
        const seed = database
          .prepare(
            `INSERT INTO budget_ledger (day, scope, used, limit_value)
              SELECT ?, ?, 0, ? WHERE NOT EXISTS (
                SELECT 1 FROM budget_charges WHERE scope = ? AND work_id = ?
              ) ON CONFLICT DO NOTHING`,
          )
          .bind(request.day, request.scope, request.limit, request.scope, request.workId);
        const charge = database
          .prepare(`INSERT INTO budget_charges (scope, work_id, day, amount, granted, used_after)
          SELECT scope, ?, day, ?, CASE WHEN ? <= limit_value - used THEN 1 ELSE 0 END,
            CASE WHEN ? <= limit_value - used THEN used + ? ELSE used END
          FROM budget_ledger WHERE day = ? AND scope = ? AND limit_value = ?
          ON CONFLICT DO NOTHING`)
          .bind(
            request.workId,
            request.amount,
            request.amount,
            request.amount,
            request.amount,
            request.day,
            request.scope,
            request.limit,
          );
        // Replaying a receipt cannot advance a ledger that has already reached its balance.
        const consume = database
          .prepare(`UPDATE budget_ledger AS l SET used = c.used_after FROM budget_charges c
            WHERE c.scope = ? AND c.work_id = ? AND l.day = c.day AND l.scope = c.scope
              AND l.used < c.used_after`)
          .bind(request.scope, request.workId);
        const read = database
          .prepare(`SELECT l.day, l.scope, l.limit_value, c.used_after AS used, c.amount, c.granted
          FROM budget_charges c JOIN budget_ledger l ON l.day = c.day AND l.scope = c.scope
          WHERE c.scope = ? AND c.work_id = ?`)
          .bind(request.scope, request.workId);
        const [, , , result] = await database.batch<Row>([seed, charge, consume, read]);
        const row = result?.results[0];
        if (row === undefined || row["amount"] !== request.amount)
          throw new AppError("STATE_CONFLICT");
        return { granted: row["granted"] === 1, entry: decodeBudgetLedgerEntry(row) };
      });
    },
    async get(day, scope): Promise<BudgetLedgerEntry | null> {
      return execute(() =>
        first(
          "SELECT * FROM budget_ledger WHERE day = ? AND scope = ?",
          [day, scope],
          decodeBudgetLedgerEntry,
        ),
      );
    },
  };

  const audit: AuditLog = {
    async append(entry): Promise<void> {
      await execute(async () => {
        await database
          .prepare(`INSERT OR IGNORE INTO audit_log (id, actor, action, target, detail_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(
            entry.id,
            entry.actor,
            entry.action,
            entry.target,
            json(entry.detail_json),
            entry.created_at,
          )
          .run();
      });
    },
    async listRecent(limit): Promise<readonly AuditLogEntry[]> {
      const bounded = parseBoundary(StorageLimitSchema, limit, "INPUT_INVALID");
      return execute(() =>
        all(
          "SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?",
          [bounded],
          decodeAuditLogEntry,
        ),
      );
    },
  };

  const config: ConfigStore = {
    async getCurrent(): Promise<ConfigVersion | null> {
      return execute(() =>
        first(
          "SELECT * FROM config_versions ORDER BY version DESC LIMIT 1",
          [],
          decodeConfigVersion,
        ),
      );
    },
    async publish(value: AppConfig, actor, at: EpochMs): Promise<ConfigVersion> {
      return execute(async () => {
        const row = await database
          .prepare(`INSERT INTO config_versions (version, config_json, created_at, created_by)
            SELECT COALESCE(MAX(version), 0) + 1, ?, ?, ? FROM config_versions RETURNING *`)
          .bind(json(value), at, actor)
          .first<Row>();
        if (row === null) throw new AppError("STORAGE_UNAVAILABLE");
        return decodeConfigVersion(row);
      });
    },
  };

  const admin: AdminRepo = {
    async listDestinations(): Promise<readonly DestinationSummary[]> {
      return execute(() =>
        all(
          `SELECT id, name, purpose, channel, lang, enabled, dry_run, min_tier, daily_budget,
          source_filters_json, quiet_hours_json, created_at, updated_at
          FROM destinations ORDER BY created_at, id`,
          [],
          decodeDestinationSummary,
        ),
      );
    },
    async patchDestination(id, input, change): Promise<boolean> {
      parseBoundary(AdminChangeSchema, change, "INPUT_INVALID");
      const patch = parseBoundary(DestinationPatchSchema, input, "INPUT_INVALID");
      const { lang, enabled, dry_run, min_tier, daily_budget, source_filters, quiet_hours } = patch;
      return execute(async () => {
        const update = database
          .prepare(`UPDATE destinations SET
          lang = COALESCE(?, lang), enabled = COALESCE(?, enabled), dry_run = COALESCE(?, dry_run),
          min_tier = COALESCE(?, min_tier), daily_budget = COALESCE(?, daily_budget),
          source_filters_json = COALESCE(?, source_filters_json),
          quiet_hours_json = CASE WHEN ? THEN ? ELSE quiet_hours_json END, updated_at = ?
          WHERE id = ? AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`)
          .bind(
            lang ?? null,
            enabled === undefined ? null : integer(enabled),
            dry_run === undefined ? null : integer(dry_run),
            min_tier ?? null,
            daily_budget ?? null,
            source_filters === undefined ? null : json(source_filters),
            integer(quiet_hours !== undefined),
            quiet_hours === undefined ? null : nullableJson(quiet_hours),
            change.at,
            id,
            change.id,
          );
        const writeAudit = database
          .prepare(`INSERT INTO audit_log (id, actor, action, target, detail_json, created_at)
          SELECT ?, ?, 'destination.patch', ?, ?, ? WHERE EXISTS (SELECT 1 FROM destinations WHERE id = ?)
            AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`)
          .bind(
            change.id,
            change.actor,
            `destination:${id}`,
            json(patch),
            change.at,
            id,
            change.id,
          );
        const [result] = await database.batch([update, writeAudit]);
        return result?.meta.changes === 1;
      });
    },
    async publishConfig(value, expectedVersion, change): Promise<ConfigVersion | null> {
      parseBoundary(AdminChangeSchema, change, "INPUT_INVALID");
      const validated = parseBoundary(AppConfigSchema, value, "CONFIG_INVALID");
      return execute(async () => {
        const currentVersion = "(SELECT COALESCE(MAX(version), 0) FROM config_versions)";
        const publish = database
          .prepare(`INSERT INTO config_versions (version, config_json, created_at, created_by)
          SELECT ?, ?, ?, ? WHERE ? = ${currentVersion} RETURNING *`)
          .bind(expectedVersion + 1, json(validated), change.at, change.actor, expectedVersion);
        const writeAudit = database
          .prepare(`INSERT INTO audit_log (id, actor, action, target, detail_json, created_at)
          SELECT ?, ?, 'config.publish', ?, ?, ? WHERE ? = ${currentVersion}`)
          .bind(
            change.id,
            change.actor,
            `config:${expectedVersion + 1}`,
            json({ previous: expectedVersion }),
            change.at,
            expectedVersion,
          );
        try {
          const [, result] = await database.batch<Row>([writeAudit, publish]);
          const row = result?.results[0];
          return row === undefined ? null : decodeConfigVersion(row);
        } catch (cause) {
          const existing = await database
            .prepare("SELECT id FROM audit_log WHERE id = ?")
            .bind(change.id)
            .first<Row>();
          if (existing !== null) return null;
          throw cause;
        }
      });
    },
  };

  return {
    sources,
    items,
    snapshots,
    revisions,
    analyses,
    alerts,
    deliveries,
    destinations,
    budgets,
    audit,
    config,
    admin,
  };
}

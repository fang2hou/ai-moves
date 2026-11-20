import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { AppConfig } from "@ai-moves/contracts/config";
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
  DeliveryTransition,
  DestinationRepo,
  Inserted,
  ItemPatch,
  ItemRepo,
  ItemRevisionRepo,
  ItemSnapshotRepo,
  ItemTransition,
  NewSource,
  SourcePollOutcome,
  SourceRepo,
} from "@ai-moves/contracts/ports/storage";
import type { EpochMs } from "@ai-moves/contracts/primitives";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import {
  decodeAlert,
  decodeAnalysis,
  decodeAuditLogEntry,
  decodeBudgetLedgerEntry,
  decodeConfigVersion,
  decodeDelivery,
  decodeDestination,
  decodeItem,
  decodeItemRevision,
  decodeItemSnapshot,
  decodeSource,
  integer,
  json,
  nullableJson,
} from "./codecs.ts";

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

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
    values.push(nullableJson(patch.last_error));
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
    async listDue(now, limit): Promise<readonly Source[]> {
      return execute(() =>
        all(
          "SELECT * FROM sources WHERE status != 'disabled' AND next_poll_at <= ? ORDER BY next_poll_at, id LIMIT ?",
          [now, limit],
          decodeSource,
        ),
      );
    },
    async scheduleNextPoll(updates): Promise<void> {
      if (updates.length === 0) return;
      await execute(async () => {
        await database.batch(
          updates.map(({ id, next_poll_at }) =>
            database
              .prepare("UPDATE sources SET next_poll_at = ? WHERE id = ?")
              .bind(next_poll_at, id),
          ),
        );
      });
    },
    async recordPollOutcome(id, outcome: SourcePollOutcome): Promise<void> {
      await execute(async () => {
        await database
          .prepare(`UPDATE sources SET
            next_poll_at = ?, consecutive_failures = ?, status = ?, cursor_json = CASE WHEN ? IS NULL THEN cursor_json ELSE ? END,
            last_success_at = CASE WHEN ? IS NULL THEN last_success_at ELSE ? END, updated_at = ?
            WHERE id = ?`)
          .bind(
            outcome.next_poll_at,
            outcome.consecutive_failures,
            outcome.status,
            outcome.cursor_json === undefined ? null : json(outcome.cursor_json),
            outcome.cursor_json === undefined ? null : json(outcome.cursor_json),
            outcome.last_success_at ?? null,
            outcome.last_success_at ?? null,
            outcome.at,
            id,
          )
          .run();
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
            `UPDATE items SET ${prefix}state = ?, state_updated_at = ? WHERE id = ? AND state = ?`,
          )
          .bind(...patch.values, transition.to, transition.at, transition.id, transition.from)
          .run();
        return result.meta.changes === 1;
      });
    },
    async listStale(query): Promise<readonly Item[]> {
      if (query.states.length === 0) return [];
      return execute(() =>
        all(
          `SELECT * FROM items WHERE state IN (${placeholders(query.states.length)}) AND state_updated_at < ? ORDER BY state_updated_at, id LIMIT ?`,
          [...query.states, query.updatedBefore, query.limit],
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
    async complete(id, completion: AnalysisCompletion): Promise<void> {
      await execute(async () => {
        const result = await database
          .prepare(`UPDATE analyses SET status = ?, output_json = ?, r2_key = ?, usage_json = ?,
            error_code = ?, updated_at = ? WHERE id = ?`)
          .bind(
            completion.status,
            nullableJson(completion.output_json),
            completion.r2_key,
            nullableJson(completion.usage_json),
            completion.error_code,
            completion.at,
            id,
          )
          .run();
        if (result.meta.changes === 0) throw new AppError("STATE_CONFLICT");
      });
    },
  };

  const alerts: AlertRepo = {
    async insertWithDeliveries(alert, deliveriesToInsert): Promise<Inserted<Alert>> {
      return execute(async () => {
        const existing = await first<Alert>(
          "SELECT * FROM alerts WHERE alert_key = ?",
          [alert.alert_key],
          decodeAlert,
        );
        if (existing !== null) return inserted(existing, false);

        const statements: D1PreparedStatement[] = [
          database
            .prepare(`INSERT INTO alerts (
              id, alert_key, item_id, analysis_id, cluster_id, tier, kind, decision,
              decision_reason_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
                nullableJson(delivery.last_error),
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
            "SELECT * FROM alerts WHERE alert_key = ?",
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
      return execute(() => first("SELECT * FROM alerts WHERE id = ?", [id], decodeAlert));
    },
    async getByKey(alertKey): Promise<Alert | null> {
      return execute(() =>
        first("SELECT * FROM alerts WHERE alert_key = ?", [alertKey], decodeAlert),
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
    async transition(transition: DeliveryTransition): Promise<boolean> {
      return execute(async () => {
        const patch = buildDeliveryPatch(transition.patch ?? {});
        const prefix = patch.sql.length === 0 ? "" : `${patch.sql}, `;
        const result = await database
          .prepare(
            `UPDATE deliveries SET ${prefix}state = ?, state_updated_at = ? WHERE id = ? AND state = ?`,
          )
          .bind(...patch.values, transition.to, transition.at, transition.id, transition.from)
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
      if (query.states.length === 0) return [];
      return execute(() =>
        all(
          `SELECT * FROM deliveries WHERE state IN (${placeholders(query.states.length)})
           AND state_updated_at < ? ORDER BY state_updated_at, id LIMIT ?`,
          [...query.states, query.updatedBefore, query.limit],
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
    async setEnabled(id, enabled, at): Promise<void> {
      await execute(async () => {
        const result = await database
          .prepare("UPDATE destinations SET enabled = ?, updated_at = ? WHERE id = ?")
          .bind(integer(enabled), at, id)
          .run();
        if (result.meta.changes === 0) throw new AppError("STATE_CONFLICT");
      });
    },
  };

  const budgets: BudgetLedger = {
    async tryConsume(request: BudgetRequest): Promise<BudgetGrant> {
      return execute(async () => {
        const seed = database
          .prepare(
            "INSERT INTO budget_ledger (day, scope, used, limit_value) VALUES (?, ?, 0, ?) ON CONFLICT DO NOTHING",
          )
          .bind(request.day, request.scope, request.limit);
        const consume = database
          .prepare(`UPDATE budget_ledger SET used = used + ?
            WHERE day = ? AND scope = ? AND limit_value = ? AND used + ? <= limit_value`)
          .bind(request.amount, request.day, request.scope, request.limit, request.amount);
        const results = await database.batch([seed, consume]);
        const result = results[1];
        if (result === undefined) throw new AppError("STORAGE_UNAVAILABLE");
        const row = await first<BudgetLedgerEntry>(
          "SELECT * FROM budget_ledger WHERE day = ? AND scope = ?",
          [request.day, request.scope],
          decodeBudgetLedgerEntry,
        );
        if (row === null) throw new AppError("STORAGE_UNAVAILABLE");
        if (row.limit !== request.limit) throw new AppError("STATE_CONFLICT");
        return { granted: result.meta.changes === 1, entry: row };
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
      return execute(() =>
        all(
          "SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?",
          [limit],
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
  };
}

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
import type { AppConfig } from "@ai-moves/contracts/config";
import type {
  AlertRepo,
  AnalysisCompletion,
  AnalysisRepo,
  AuditLog,
  BudgetLedger,
  BudgetGrant,
  BudgetRequest,
  ConfigStore,
  DeliveryRepo,
  DestinationRepo,
  Inserted,
  ItemRepo,
  ItemRevisionRepo,
  ItemSnapshotRepo,
  ItemTransition,
  NewSource,
  ObservedItem,
  SourcePollOutcome,
  SourceRepo,
  StaleQuery,
} from "@ai-moves/contracts/ports/storage";
import type { EntityId, EpochMs } from "@ai-moves/contracts/primitives";
import { AppError } from "@ai-moves/kernel/errors/app-error";

export interface MemoryStorageHarness {
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

function copy<T>(value: T): T {
  return structuredClone(value);
}

function copyOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : copy(value);
}

function inserted<T>(value: T, created: boolean): Inserted<T> {
  return { value: copy(value), created };
}

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new AppError("STATE_CONFLICT");
  return value;
}

function compareCreated<T extends { created_at: EpochMs; id: EntityId }>(
  left: T,
  right: T,
): number {
  return left.created_at - right.created_at || left.id.localeCompare(right.id);
}

function analysisKey(key: AnalysisKey): string {
  return [key.item_id, key.stage, key.input_hash, key.prompt_version, key.lang].join("\0");
}

function sortByUpdate<T extends { state_updated_at: EpochMs; id: EntityId }>(rows: T[]): T[] {
  return rows.toSorted(
    (left, right) =>
      left.state_updated_at - right.state_updated_at || left.id.localeCompare(right.id),
  );
}

function staleRows<T extends { state: State; state_updated_at: EpochMs; id: EntityId }, State>(
  rows: readonly T[],
  query: StaleQuery<State>,
): T[] {
  return sortByUpdate(
    rows.filter(
      (row) => query.states.includes(row.state) && row.state_updated_at < query.updatedBefore,
    ),
  ).slice(0, query.limit);
}

export function createMemoryStorage(): MemoryStorageHarness {
  const sourceRows = new Map<EntityId, Source>();
  const sourceIdsByKey = new Map<string, EntityId>();
  const itemRows = new Map<EntityId, Item>();
  const itemIdsByExternalKey = new Map<string, EntityId>();
  const snapshotRows = new Map<string, ItemSnapshot>();
  const revisionRows = new Map<string, ItemRevision>();
  const analysisRows = new Map<EntityId, Analysis>();
  const analysisIdsByKey = new Map<string, EntityId>();
  const alertRows = new Map<EntityId, Alert>();
  const alertIdsByKey = new Map<string, EntityId>();
  const deliveryRows = new Map<EntityId, Delivery>();
  const deliveryIdsByKey = new Map<string, EntityId>();
  const destinationRows = new Map<EntityId, Destination>();
  const destinationIdsByName = new Map<string, EntityId>();
  const budgetRows = new Map<string, BudgetLedgerEntry>();
  const auditRows = new Map<EntityId, AuditLogEntry>();
  const configRows = new Map<number, ConfigVersion>();
  let currentConfigVersion = 0;

  const sources: SourceRepo = {
    async upsert(source: NewSource): Promise<Inserted<Source>> {
      const existingId = sourceIdsByKey.get(source.key);
      if (existingId !== undefined)
        return inserted(requireValue(sourceRows.get(existingId)), false);
      if (sourceRows.has(source.id)) throw new AppError("STATE_CONFLICT");
      const row: Source = {
        ...copy(source),
        consecutive_failures: 0,
        last_success_at: null,
        status: "active",
      };
      sourceRows.set(row.id, row);
      sourceIdsByKey.set(row.key, row.id);
      return inserted(row, true);
    },
    async get(id): Promise<Source | null> {
      return copyOrNull(sourceRows.get(id));
    },
    async list(): Promise<readonly Source[]> {
      return [...sourceRows.values()].toSorted(compareCreated).map(copy);
    },
    async listDue(now, limit): Promise<readonly Source[]> {
      return [...sourceRows.values()]
        .filter((source) => source.status !== "disabled" && source.next_poll_at <= now)
        .toSorted(
          (left, right) =>
            left.next_poll_at - right.next_poll_at || left.id.localeCompare(right.id),
        )
        .slice(0, limit)
        .map(copy);
    },
    async scheduleNextPoll(updates): Promise<void> {
      for (const update of updates) {
        const row = requireValue(sourceRows.get(update.id));
        sourceRows.set(row.id, { ...row, next_poll_at: update.next_poll_at });
      }
    },
    async recordPollOutcome(id, outcome: SourcePollOutcome): Promise<void> {
      const row = requireValue(sourceRows.get(id));
      sourceRows.set(row.id, {
        ...row,
        next_poll_at: outcome.next_poll_at,
        consecutive_failures: outcome.consecutive_failures,
        status: outcome.status,
        cursor_json:
          outcome.cursor_json === undefined ? row.cursor_json : copy(outcome.cursor_json),
        last_success_at:
          outcome.last_success_at === undefined ? row.last_success_at : outcome.last_success_at,
        updated_at: outcome.at,
      });
    },
  };

  const items: ItemRepo = {
    async upsertObserved(observed: ObservedItem): Promise<Inserted<Item>> {
      const existingId = itemIdsByExternalKey.get(observed.external_key);
      if (existingId !== undefined) {
        const row = requireValue(itemRows.get(existingId));
        if (observed.observed_at > row.last_seen_at) {
          itemRows.set(row.id, { ...row, last_seen_at: observed.observed_at });
        }
        return inserted(requireValue(itemRows.get(existingId)), false);
      }
      if (itemRows.has(observed.id)) throw new AppError("STATE_CONFLICT");
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
      itemRows.set(row.id, row);
      itemIdsByExternalKey.set(row.external_key, row.id);
      return inserted(row, true);
    },
    async get(id): Promise<Item | null> {
      return copyOrNull(itemRows.get(id));
    },
    async getByExternalKey(externalKey): Promise<Item | null> {
      const id = itemIdsByExternalKey.get(externalKey);
      return id === undefined ? null : this.get(id);
    },
    async listBySourceAndStates(sourceId, states, limit): Promise<readonly Item[]> {
      return [...itemRows.values()]
        .filter((item) => item.source_id === sourceId && states.includes(item.state))
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(copy);
    },
    async update(id, patch): Promise<void> {
      const row = requireValue(itemRows.get(id));
      itemRows.set(id, { ...row, ...copy(patch) });
    },
    async transition(transition: ItemTransition): Promise<boolean> {
      const row = itemRows.get(transition.id);
      if (row === undefined || row.state !== transition.from) return false;
      itemRows.set(row.id, {
        ...row,
        ...copy(transition.patch ?? {}),
        state: transition.to,
        state_updated_at: transition.at,
      });
      return true;
    },
    async listStale(query): Promise<readonly Item[]> {
      return staleRows([...itemRows.values()], query).map(copy);
    },
  };

  const snapshots: ItemSnapshotRepo = {
    async insertIfAbsent(snapshot): Promise<boolean> {
      const key = `${snapshot.item_id}\0${snapshot.sampled_at}`;
      if (snapshotRows.has(key)) return false;
      snapshotRows.set(key, copy(snapshot));
      return true;
    },
    async listSince(itemId, since): Promise<readonly ItemSnapshot[]> {
      return [...snapshotRows.values()]
        .filter((snapshot) => snapshot.item_id === itemId && snapshot.sampled_at >= since)
        .toSorted((left, right) => left.sampled_at - right.sampled_at)
        .map(copy);
    },
    async deleteBefore(cutoff, limit): Promise<number> {
      const keys = [...snapshotRows.entries()]
        .filter(([, snapshot]) => snapshot.sampled_at < cutoff)
        .toSorted(([leftKey, left], [rightKey, right]) =>
          left.sampled_at === right.sampled_at
            ? leftKey.localeCompare(rightKey)
            : left.sampled_at - right.sampled_at,
        )
        .slice(0, limit)
        .map(([key]) => key);
      for (const key of keys) snapshotRows.delete(key);
      return keys.length;
    },
  };

  const revisions: ItemRevisionRepo = {
    async insertIfAbsent(revision): Promise<boolean> {
      const key = `${revision.item_id}\0${revision.content_hash}`;
      if (revisionRows.has(key)) return false;
      revisionRows.set(key, copy(revision));
      return true;
    },
    async listByItem(itemId): Promise<readonly ItemRevision[]> {
      return [...revisionRows.values()]
        .filter((revision) => revision.item_id === itemId)
        .toSorted(
          (left, right) =>
            left.observed_at - right.observed_at ||
            left.content_hash.localeCompare(right.content_hash),
        )
        .map(copy);
    },
  };

  const analyses: AnalysisRepo = {
    async insertIfAbsent(analysis): Promise<Inserted<Analysis>> {
      const key = analysisKey(analysis);
      const existingId = analysisIdsByKey.get(key);
      if (existingId !== undefined)
        return inserted(requireValue(analysisRows.get(existingId)), false);
      if (analysisRows.has(analysis.id)) throw new AppError("STATE_CONFLICT");
      analysisRows.set(analysis.id, copy(analysis));
      analysisIdsByKey.set(key, analysis.id);
      return inserted(analysis, true);
    },
    async get(id): Promise<Analysis | null> {
      return copyOrNull(analysisRows.get(id));
    },
    async findByKey(key): Promise<Analysis | null> {
      const id = analysisIdsByKey.get(analysisKey(key));
      return id === undefined ? null : this.get(id);
    },
    async complete(id, completion: AnalysisCompletion): Promise<void> {
      const row = requireValue(analysisRows.get(id));
      analysisRows.set(id, {
        ...row,
        status: completion.status,
        output_json: copy(completion.output_json),
        r2_key: completion.r2_key,
        usage_json: copy(completion.usage_json),
        error_code: completion.error_code,
        updated_at: completion.at,
      });
    },
  };

  const deliveries: DeliveryRepo = {
    async get(id): Promise<Delivery | null> {
      return copyOrNull(deliveryRows.get(id));
    },
    async listByAlert(alertId): Promise<readonly Delivery[]> {
      return [...deliveryRows.values()]
        .filter((delivery) => delivery.alert_id === alertId)
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .map(copy);
    },
    async transition(transition): Promise<boolean> {
      const row = deliveryRows.get(transition.id);
      if (row === undefined || row.state !== transition.from) return false;
      deliveryRows.set(row.id, {
        ...row,
        ...copy(transition.patch ?? {}),
        state: transition.to,
        state_updated_at: transition.at,
      });
      return true;
    },
    async listDue(now, limit): Promise<readonly Delivery[]> {
      return [...deliveryRows.values()]
        .filter(
          (delivery) =>
            (delivery.state === "pending" || delivery.state === "failed_retryable") &&
            (delivery.next_attempt_at === null || delivery.next_attempt_at <= now),
        )
        .toSorted(
          (left, right) =>
            (left.next_attempt_at ?? 0) - (right.next_attempt_at ?? 0) ||
            left.id.localeCompare(right.id),
        )
        .slice(0, limit)
        .map(copy);
    },
    async listStale(query): Promise<readonly Delivery[]> {
      return staleRows([...deliveryRows.values()], query).map(copy);
    },
  };

  const alerts: AlertRepo = {
    async insertWithDeliveries(alert, newDeliveries): Promise<Inserted<Alert>> {
      const existingId = alertIdsByKey.get(alert.alert_key);
      if (existingId !== undefined) return inserted(requireValue(alertRows.get(existingId)), false);
      if (alertRows.has(alert.id)) throw new AppError("STATE_CONFLICT");

      const staged = new Map<EntityId, Delivery>();
      const stagedKeys = new Set<string>();
      for (const delivery of newDeliveries) {
        if (delivery.alert_id !== alert.id) throw new AppError("STATE_CONFLICT");
        if (stagedKeys.has(delivery.idempotency_key)) continue;
        if (
          staged.has(delivery.id) ||
          deliveryRows.has(delivery.id) ||
          deliveryIdsByKey.has(delivery.idempotency_key)
        ) {
          throw new AppError("STATE_CONFLICT");
        }
        staged.set(delivery.id, copy(delivery));
        stagedKeys.add(delivery.idempotency_key);
      }
      for (const delivery of staged.values()) {
        deliveryRows.set(delivery.id, delivery);
        deliveryIdsByKey.set(delivery.idempotency_key, delivery.id);
      }
      alertRows.set(alert.id, copy(alert));
      alertIdsByKey.set(alert.alert_key, alert.id);
      return inserted(alert, true);
    },
    async get(id): Promise<Alert | null> {
      return copyOrNull(alertRows.get(id));
    },
    async getByKey(alertKey): Promise<Alert | null> {
      const id = alertIdsByKey.get(alertKey);
      return id === undefined ? null : this.get(id);
    },
  };

  const destinations: DestinationRepo = {
    async upsert(destination): Promise<Inserted<Destination>> {
      const existingId = destinationIdsByName.get(destination.name);
      if (existingId !== undefined)
        return inserted(requireValue(destinationRows.get(existingId)), false);
      if (destinationRows.has(destination.id)) throw new AppError("STATE_CONFLICT");
      destinationRows.set(destination.id, copy(destination));
      destinationIdsByName.set(destination.name, destination.id);
      return inserted(destination, true);
    },
    async get(id): Promise<Destination | null> {
      return copyOrNull(destinationRows.get(id));
    },
    async list(): Promise<readonly Destination[]> {
      return [...destinationRows.values()].toSorted(compareCreated).map(copy);
    },
    async setEnabled(id, enabled, at): Promise<void> {
      const row = requireValue(destinationRows.get(id));
      destinationRows.set(id, { ...row, enabled, updated_at: at });
    },
  };

  const budgets: BudgetLedger = {
    async tryConsume(request: BudgetRequest): Promise<BudgetGrant> {
      const key = `${request.day}\0${request.scope}`;
      const current = budgetRows.get(key);
      if (current !== undefined && current.limit !== request.limit)
        throw new AppError("STATE_CONFLICT");
      const used = current?.used ?? 0;
      if (current === undefined) {
        budgetRows.set(key, {
          day: request.day,
          scope: request.scope,
          used,
          limit: request.limit,
        });
      }
      const granted = used + request.amount <= request.limit;
      const entry = {
        day: request.day,
        scope: request.scope,
        used: granted ? used + request.amount : used,
        limit: request.limit,
      };
      if (granted) budgetRows.set(key, entry);
      return { granted, entry: copy(entry) };
    },
    async get(day, scope): Promise<BudgetLedgerEntry | null> {
      return copyOrNull(budgetRows.get(`${day}\0${scope}`));
    },
  };

  const audit: AuditLog = {
    async append(entry): Promise<void> {
      if (!auditRows.has(entry.id)) auditRows.set(entry.id, copy(entry));
    },
    async listRecent(limit): Promise<readonly AuditLogEntry[]> {
      return [...auditRows.values()]
        .toSorted(
          (left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id),
        )
        .slice(0, limit)
        .map(copy);
    },
  };

  const config: ConfigStore = {
    async getCurrent(): Promise<ConfigVersion | null> {
      return copyOrNull(configRows.get(currentConfigVersion));
    },
    async publish(value: AppConfig, actor, at): Promise<ConfigVersion> {
      currentConfigVersion += 1;
      const row: ConfigVersion = {
        version: currentConfigVersion,
        config: copy(value),
        created_at: at,
        created_by: actor,
      };
      configRows.set(currentConfigVersion, row);
      return copy(row);
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

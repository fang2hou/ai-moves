import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import type {
  Alert,
  Analysis,
  AnalysisKey,
  AuditLogEntry,
  ConfigVersion,
  Delivery,
  Destination,
  Item,
  ItemRevision,
  ItemSnapshot,
  Source,
} from "@ai-moves/contracts/entities";
import { AppConfigSchema, type AppConfig } from "@ai-moves/contracts/config";
import {
  AdminChangeSchema,
  AlertFeedQuerySchema,
  DestinationPatchSchema,
  DestinationSummarySchema,
  FeedQuerySchema,
  StorageLimitSchema,
} from "@ai-moves/contracts/ports/storage";
import type {
  AdminRepo,
  AlertRepo,
  AnalysisCompletion,
  AnalysisRepo,
  AuditLog,
  ConfigStore,
  DeliveryRepo,
  DeliverySendClaim,
  DeliverySendRequest,
  DestinationRepo,
  Inserted,
  ItemRepo,
  ItemRevisionRepo,
  ItemSnapshotRepo,
  ItemTransition,
  NewSource,
  ObservedItem,
  PollWork,
  SourceRepo,
  StaleQuery,
} from "@ai-moves/contracts/ports/storage";
import type { EntityId, EpochMs, JsonObject } from "@ai-moves/contracts/primitives";
import { isDeliveryTransitionAllowed } from "@ai-moves/contracts/states";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import {
  beforeCursor,
  compareId,
  matchesVersion,
  sendIntervalCutoff,
  validateAlertDocuments,
  validateLease,
} from "./rules.ts";

export interface MemoryStorageHarness {
  readonly sources: SourceRepo;
  readonly items: ItemRepo;
  readonly snapshots: ItemSnapshotRepo;
  readonly revisions: ItemRevisionRepo;
  readonly analyses: AnalysisRepo;
  readonly alerts: AlertRepo;
  readonly deliveries: DeliveryRepo;
  readonly destinations: DestinationRepo;
  readonly audit: AuditLog;
  readonly config: ConfigStore;
  readonly admin: AdminRepo;
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
  return left.created_at - right.created_at || compareId(left.id, right.id);
}

function analysisKey(key: AnalysisKey): string {
  return [key.item_id, key.stage, key.input_hash, key.prompt_version, key.lang].join("\0");
}

function sortByUpdate<T extends { state_updated_at: EpochMs; id: EntityId }>(rows: T[]): T[] {
  return rows.toSorted(
    (left, right) => left.state_updated_at - right.state_updated_at || compareId(left.id, right.id),
  );
}

function staleRows<
  T extends {
    state: State;
    state_updated_at: EpochMs;
    id: EntityId;
    next_attempt_at: EpochMs | null;
  },
  State,
>(rows: readonly T[], query: StaleQuery<State>): T[] {
  return sortByUpdate(
    rows.filter(
      (row) =>
        query.states.includes(row.state) &&
        row.state_updated_at < query.updatedBefore &&
        (query.readyAt === undefined ||
          row.next_attempt_at === null ||
          row.next_attempt_at <= query.readyAt),
    ),
  ).slice(0, parseBoundary(StorageLimitSchema, query.limit, "INPUT_INVALID"));
}

export function createMemoryStorage(): MemoryStorageHarness {
  const sourceRows = new Map<EntityId, Source>();
  const sourceIdsByKey = new Map<string, EntityId>();
  const pollRows = new Map<
    EntityId,
    PollWork & { readyAt: EpochMs | null; owner: EntityId | null }
  >();
  const itemRows = new Map<EntityId, Item>();
  const itemIdsByExternalKey = new Map<string, EntityId>();
  const snapshotRows = new Map<string, ItemSnapshot>();
  const revisionRows = new Map<string, ItemRevision>();
  const analysisRows = new Map<EntityId, Analysis>();
  const analysisIdsByKey = new Map<string, EntityId>();
  const analysisLeases = new Map<EntityId, { owner: EntityId; expiresAt: EpochMs }>();
  const alertRows = new Map<EntityId, Alert>();
  const alertIdsByKey = new Map<string, EntityId>();
  const alertDocuments = new Map<EntityId, readonly AlertDoc[]>();
  const deliveryRows = new Map<EntityId, Delivery>();
  const liveSendIds = new Set<EntityId>();
  const deliveryIdsByKey = new Map<string, EntityId>();
  const destinationRows = new Map<EntityId, Destination>();
  const destinationIdsByName = new Map<string, EntityId>();
  const auditRows = new Map<EntityId, AuditLogEntry>();
  const configRows = new Map<number, ConfigVersion>();
  let currentConfigVersion = 0;

  function insertConfig(config: AppConfig, actor: string, at: EpochMs): ConfigVersion {
    currentConfigVersion += 1;
    const row: ConfigVersion = {
      version: currentConfigVersion,
      config,
      created_at: at,
      created_by: actor,
    };
    configRows.set(row.version, row);
    return row;
  }

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
    async scheduleDue(now, tickBucket, limit): Promise<void> {
      const due = [...sourceRows.values()]
        .filter((source) => {
          const poll = pollRows.get(source.id);
          return (
            source.status !== "disabled" &&
            source.next_poll_at <= now &&
            (poll === undefined || (poll.readyAt === null && poll.tick_bucket < tickBucket))
          );
        })
        .toSorted(
          (left, right) => left.next_poll_at - right.next_poll_at || compareId(left.id, right.id),
        )
        .slice(0, parseBoundary(StorageLimitSchema, limit, "INPUT_INVALID"));
      for (const source of due) {
        pollRows.set(source.id, {
          source_id: source.id,
          tick_bucket: tickBucket,
          readyAt: now,
          owner: null,
        });
      }
    },
    async listReadyPolls(now, limit): Promise<readonly PollWork[]> {
      return [...pollRows.values()]
        .flatMap((poll) =>
          poll.readyAt !== null && poll.readyAt <= now ? [{ ...poll, readyAt: poll.readyAt }] : [],
        )
        .toSorted(
          (left, right) =>
            left.readyAt - right.readyAt || compareId(left.source_id, right.source_id),
        )
        .slice(0, parseBoundary(StorageLimitSchema, limit, "INPUT_INVALID"))
        .map(({ source_id, tick_bucket }) => ({ source_id, tick_bucket }));
    },
    async claimPoll(work, lease): Promise<Source | null> {
      validateLease(lease);
      const poll = pollRows.get(work.source_id);
      if (
        poll === undefined ||
        poll.tick_bucket !== work.tick_bucket ||
        poll.readyAt === null ||
        poll.readyAt > lease.now
      )
        return null;
      const source = requireValue(sourceRows.get(work.source_id));
      pollRows.set(source.id, { ...poll, owner: lease.owner, readyAt: lease.expiresAt });
      return copy(source);
    },
    async finishPoll(work, owner, outcome): Promise<boolean> {
      const poll = pollRows.get(work.source_id);
      if (
        poll === undefined ||
        poll.tick_bucket !== work.tick_bucket ||
        poll.owner !== owner ||
        poll.readyAt === null ||
        poll.readyAt <= outcome.at
      )
        return false;
      const row = requireValue(sourceRows.get(work.source_id));
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
      pollRows.set(row.id, { ...poll, readyAt: null, owner: null });
      return true;
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
    async listFeed(query): Promise<readonly Item[]> {
      const { before, limit } = parseBoundary(FeedQuerySchema, query, "INPUT_INVALID");
      return [...itemRows.values()]
        .filter(
          (item) =>
            (item.state === "alerted" || item.state === "feed_only") &&
            beforeCursor(item.first_seen_at, item.id, before),
        )
        .toSorted(
          (left, right) => right.first_seen_at - left.first_seen_at || compareId(right.id, left.id),
        )
        .slice(0, limit)
        .map(copy);
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
      if (
        row === undefined ||
        row.state !== transition.from ||
        !matchesVersion(row, transition.expected)
      )
        return false;
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
    async claim(id, lease): Promise<boolean> {
      validateLease(lease);
      const row = analysisRows.get(id);
      const current = analysisLeases.get(id);
      if (row?.status !== "pending" || (current !== undefined && current.expiresAt > lease.now))
        return false;
      analysisLeases.set(id, { owner: lease.owner, expiresAt: lease.expiresAt });
      return true;
    },
    async complete(id, owner, completion: AnalysisCompletion): Promise<boolean> {
      const row = analysisRows.get(id);
      const lease = analysisLeases.get(id);
      if (row?.status !== "pending" || lease?.owner !== owner || lease.expiresAt <= completion.at)
        return false;
      analysisRows.set(id, {
        ...row,
        status: completion.status,
        output_json: copy(completion.output_json),
        blob_key: completion.blob_key,
        usage_json: copy(completion.usage_json),
        error_code: completion.error_code,
        updated_at: completion.at,
      });
      analysisLeases.delete(id);
      return true;
    },
  };

  function deliveryBlock(
    alert: Alert,
    cutoff: EpochMs | null,
    maxUpdates: number,
  ): "update_limit" | "rate_limit" | null {
    if (alert.kind === "update" && maxUpdates === 0) return "update_limit";
    if (cutoff === null && alert.kind !== "update") return null;

    const updates = alert.kind === "update" ? new Set<EntityId>() : null;
    let rateLimited = false;
    for (const id of liveSendIds) {
      const other = requireValue(deliveryRows.get(id));
      if (other.alert_id === alert.id) continue;
      if (updates !== null) {
        const previous = requireValue(alertRows.get(other.alert_id));
        if (previous.item_id === alert.item_id && previous.kind === "update") {
          updates.add(previous.id);
          if (updates.size >= maxUpdates) return "update_limit";
        }
      }
      if (cutoff !== null && (other.state === "sending" || other.state_updated_at > cutoff)) {
        if (updates === null) return "rate_limit";
        rateLimited = true;
      }
    }
    return rateLimited ? "rate_limit" : null;
  }

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
    async claimForSend(request: DeliverySendRequest): Promise<DeliverySendClaim> {
      const cutoff = sendIntervalCutoff(request);
      const { id, from, expected, at, maxUpdatesPerItem } = request;
      const row = deliveryRows.get(id);
      if (
        row === undefined ||
        row.state !== from ||
        row.dry_run ||
        (row.state !== "pending" && row.state !== "failed_retryable") ||
        !matchesVersion(row, expected) ||
        at < row.state_updated_at ||
        row.expires_at <= at ||
        (row.next_attempt_at !== null && row.next_attempt_at > at)
      )
        return { kind: "unavailable" };

      const alert = requireValue(alertRows.get(row.alert_id));
      const reason = deliveryBlock(alert, cutoff, maxUpdatesPerItem);
      if (reason !== null) {
        deliveryRows.set(id, {
          ...row,
          state: "suppressed",
          state_updated_at: at,
          next_attempt_at: null,
          suppressed_reason: reason,
        });
        return { kind: "suppressed", reason };
      }
      const claimed: Delivery = {
        ...row,
        state: "sending",
        state_updated_at: at,
        next_attempt_at: null,
        suppressed_reason: null,
        attempts: row.attempts + 1,
      };
      deliveryRows.set(id, claimed);
      liveSendIds.add(id);
      return { kind: "claimed", delivery: copy(claimed) };
    },
    async transition(transition): Promise<boolean> {
      if (!isDeliveryTransitionAllowed(transition.from, transition.to)) return false;
      const row = deliveryRows.get(transition.id);
      if (
        row === undefined ||
        row.state !== transition.from ||
        !matchesVersion(row, transition.expected)
      )
        return false;
      deliveryRows.set(row.id, {
        ...row,
        ...copy(transition.patch ?? {}),
        state: transition.to,
        state_updated_at: transition.at,
      });
      if (transition.to !== "sent" && transition.to !== "unknown") liveSendIds.delete(row.id);
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
    async insertWithDeliveries(alert, newDeliveries, documents): Promise<Inserted<Alert>> {
      const existingId = alertIdsByKey.get(alert.alert_key);
      if (existingId !== undefined) return inserted(requireValue(alertRows.get(existingId)), false);
      if (alertRows.has(alert.id)) throw new AppError("STATE_CONFLICT");
      const validatedDocuments = validateAlertDocuments(alert, newDeliveries, documents);

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
      alertDocuments.set(alert.id, validatedDocuments);
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
    async replaceDocuments(id, documents): Promise<boolean> {
      const alert = alertRows.get(id);
      if (alert === undefined) return false;
      alertDocuments.set(id, [...validateAlertDocuments(alert, [], documents)]);
      return true;
    },
    async getDocument(id, lang): Promise<AlertDoc | null> {
      return copyOrNull(alertDocuments.get(id)?.find((document) => document.lang === lang));
    },
    async listFeed(query): Promise<readonly Alert[]> {
      const { before, limit, itemId } = parseBoundary(AlertFeedQuerySchema, query, "INPUT_INVALID");
      return [...alertRows.values()]
        .filter(
          (alert) =>
            (itemId === undefined || alert.item_id === itemId) &&
            beforeCursor(alert.created_at, alert.id, before),
        )
        .toSorted(
          (left, right) => right.created_at - left.created_at || compareId(right.id, left.id),
        )
        .slice(0, limit)
        .map(copy);
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
  };

  const audit: AuditLog = {
    async append(entry): Promise<void> {
      if (!auditRows.has(entry.id)) auditRows.set(entry.id, copy(entry));
    },
    async listRecent(limit): Promise<readonly AuditLogEntry[]> {
      return [...auditRows.values()]
        .toSorted(
          (left, right) => right.created_at - left.created_at || compareId(right.id, left.id),
        )
        .slice(0, parseBoundary(StorageLimitSchema, limit, "INPUT_INVALID"))
        .map(copy);
    },
  };

  const config: ConfigStore = {
    async getCurrent(): Promise<ConfigVersion | null> {
      return copyOrNull(configRows.get(currentConfigVersion));
    },
    async publish(value: AppConfig, actor, at): Promise<ConfigVersion> {
      return copy(insertConfig(copy(value), actor, at));
    },
  };

  const admin: AdminRepo = {
    async listDestinations() {
      return [...destinationRows.values()]
        .toSorted(compareCreated)
        .map((row) => DestinationSummarySchema.parse(row));
    },
    async patchDestination(id, input, change): Promise<boolean> {
      parseBoundary(AdminChangeSchema, change, "INPUT_INVALID");
      const patch = parseBoundary(DestinationPatchSchema, input, "INPUT_INVALID");
      const row = destinationRows.get(id);
      if (row === undefined || auditRows.has(change.id)) return false;
      const detail: JsonObject = {};
      for (const [field, value] of Object.entries(patch)) {
        if (value !== undefined) detail[field] = value;
      }
      const { lang, enabled, dry_run, min_tier, source_filters, quiet_hours } = patch;
      destinationRows.set(id, {
        ...row,
        lang: lang ?? row.lang,
        enabled: enabled ?? row.enabled,
        dry_run: dry_run ?? row.dry_run,
        min_tier: min_tier ?? row.min_tier,
        source_filters: source_filters ?? row.source_filters,
        quiet_hours: quiet_hours === undefined ? row.quiet_hours : quiet_hours,
        updated_at: change.at,
      });
      auditRows.set(change.id, {
        id: change.id,
        actor: change.actor,
        created_at: change.at,
        action: "destination.patch",
        target: `destination:${id}`,
        detail_json: detail,
      });
      return true;
    },
    async publishConfig(value, expectedVersion, change): Promise<ConfigVersion | null> {
      parseBoundary(AdminChangeSchema, change, "INPUT_INVALID");
      const validated = parseBoundary(AppConfigSchema, value, "CONFIG_INVALID");
      if (expectedVersion !== currentConfigVersion || auditRows.has(change.id)) return null;
      const published = insertConfig(validated, change.actor, change.at);
      auditRows.set(change.id, {
        id: change.id,
        actor: change.actor,
        created_at: change.at,
        action: "config.publish",
        target: `config:${published.version}`,
        detail_json: { previous: expectedVersion },
      });
      return copy(published);
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

    audit,
    config,
    admin,
  };
}

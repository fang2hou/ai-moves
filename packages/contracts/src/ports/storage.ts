import { z } from "zod";

import type { AlertDoc } from "../alert-doc.ts";
import type { AppConfig } from "../config.ts";
import { AuditLogEntrySchema, BudgetScopeSchema, DestinationSchema } from "../entities.ts";
import type {
  Alert,
  Analysis,
  AnalysisKey,
  AuditLogEntry,
  BudgetLedgerEntry,
  BudgetScope,
  ConfigVersion,
  Delivery,
  Destination,
  Item,
  ItemRevision,
  ItemSnapshot,
  LlmUsage,
  Source,
  SourceCursor,
} from "../entities.ts";
import type { ErrorCode, ErrorSummary } from "../errors.ts";
import {
  DayKeySchema,
  EntityIdSchema,
  EpochMsSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  type ContentHash,
  type DayKey,
  type EntityId,
  type EpochMs,
  type JsonValue,
  type Lang,
} from "../primitives.ts";
import type { ItemScore } from "../scoring.ts";
import type {
  AnalysisStatus,
  DeliveryState,
  DeliverySuppressionReason,
  HeatLevel,
  ItemState,
  SourceStatus,
} from "../states.ts";

// Persistence ports carry domain meaning rather than table access. Each write states the key that
// makes it safe to repeat. Infrastructure failures reject with STORAGE_UNAVAILABLE.

export interface Inserted<T> {
  readonly value: T;
  readonly created: boolean;
}

export type NewSource = Omit<Source, "consecutive_failures" | "last_success_at" | "status">;

export interface SourcePollOutcome {
  readonly at: EpochMs;
  readonly next_poll_at: EpochMs;
  readonly consecutive_failures: number;
  readonly status: SourceStatus;
  readonly cursor_json?: SourceCursor;
  readonly last_success_at?: EpochMs;
}

export interface SourceRepo {
  // Idempotent on `key`; an existing source keeps its cursor and counters.
  upsert(source: NewSource): Promise<Inserted<Source>>;
  get(id: EntityId): Promise<Source | null>;
  list(): Promise<readonly Source[]>;
  scheduleDue(now: EpochMs, tickBucket: number, limit: number): Promise<void>;
  listReadyPolls(now: EpochMs, limit: number): Promise<readonly PollWork[]>;
  claimPoll(work: PollWork, lease: WorkLease): Promise<Source | null>;
  finishPoll(work: PollWork, owner: EntityId, outcome: SourcePollOutcome): Promise<boolean>;
}

export interface PollWork {
  readonly source_id: EntityId;
  readonly tick_bucket: number;
}

export interface WorkLease {
  readonly owner: EntityId;
  readonly now: EpochMs;
  readonly expiresAt: EpochMs;
}

export const StorageLimitSchema = z.int().min(1).max(100);
export const FeedQuerySchema = z.strictObject({
  limit: StorageLimitSchema,
  before: z.strictObject({ at: EpochMsSchema, id: EntityIdSchema }).optional(),
});
export type FeedQuery = z.infer<typeof FeedQuerySchema>;
export const AlertFeedQuerySchema = FeedQuerySchema.extend({ itemId: EntityIdSchema.optional() });
export type AlertFeedQuery = z.infer<typeof AlertFeedQuerySchema>;

export type ObservedItem = Pick<
  Item,
  "id" | "source_id" | "external_key" | "kind" | "url" | "title" | "published_at"
> & { readonly observed_at: EpochMs; readonly state: ItemState };

export interface ItemPatch {
  readonly content_hash?: ContentHash | null;
  readonly revision?: number;
  readonly score_json?: ItemScore | null;
  readonly tier?: HeatLevel | null;
  readonly cluster_id?: string | null;
  readonly attempts?: number;
  readonly next_attempt_at?: EpochMs | null;
}

export interface ItemTransition {
  readonly id: EntityId;
  readonly from: ItemState;
  readonly to: ItemState;
  readonly at: EpochMs;
  readonly expected?: ClaimVersion;
  readonly patch?: ItemPatch;
}

export interface ClaimVersion {
  readonly state_updated_at: EpochMs;
  readonly attempts: number;
}

export interface StaleQuery<State> {
  readonly states: readonly State[];
  // Exclusive cutoff on the state update time, not on the last observation or attempt.
  readonly updatedBefore: EpochMs;
  readonly limit: number;
  readonly readyAt?: EpochMs;
}

export interface ItemRepo {
  // Idempotent on `external_key`; a repeat only advances `last_seen_at`, never moving it backward.
  upsertObserved(item: ObservedItem): Promise<Inserted<Item>>;
  get(id: EntityId): Promise<Item | null>;
  getByExternalKey(externalKey: string): Promise<Item | null>;
  listFeed(query: FeedQuery): Promise<readonly Item[]>;
  listBySourceAndStates(
    sourceId: EntityId,
    states: readonly ItemState[],
    limit: number,
  ): Promise<readonly Item[]>;
  update(id: EntityId, patch: ItemPatch): Promise<void>;
  // Conditional update on `state = from`. Resolves true only for the caller that won the claim.
  transition(transition: ItemTransition): Promise<boolean>;
  listStale(query: StaleQuery<ItemState>): Promise<readonly Item[]>;
}

export interface ItemSnapshotRepo {
  // Idempotent on `(item_id, sampled_at)`.
  insertIfAbsent(snapshot: ItemSnapshot): Promise<boolean>;
  listSince(itemId: EntityId, since: EpochMs): Promise<readonly ItemSnapshot[]>;
  deleteBefore(cutoff: EpochMs, limit: number): Promise<number>;
}

export interface ItemRevisionRepo {
  // Idempotent on `(item_id, content_hash)`.
  insertIfAbsent(revision: ItemRevision): Promise<boolean>;
  listByItem(itemId: EntityId): Promise<readonly ItemRevision[]>;
}

export interface AnalysisCompletion {
  readonly status: Exclude<AnalysisStatus, "pending">;
  readonly at: EpochMs;
  readonly output_json: JsonValue | null;
  readonly r2_key: string | null;
  readonly usage_json: LlmUsage | null;
  readonly error_code: ErrorCode | null;
}

export interface AnalysisRepo {
  // Idempotent on the analysis key; an existing row is returned untouched.
  insertIfAbsent(analysis: Analysis): Promise<Inserted<Analysis>>;
  get(id: EntityId): Promise<Analysis | null>;
  findByKey(key: AnalysisKey): Promise<Analysis | null>;
  claim(id: EntityId, lease: WorkLease): Promise<boolean>;
  complete(id: EntityId, owner: EntityId, completion: AnalysisCompletion): Promise<boolean>;
}

export interface AlertRepo {
  // Idempotent on `alert_key` and on each delivery's `idempotency_key`. A failed write must not
  // leave the new alert or any of its deliveries visible. A primary key collision under a
  // different idempotency key is not a replay.
  insertWithDeliveries(
    alert: Alert,
    deliveries: readonly Delivery[],
    documents: readonly AlertDoc[],
  ): Promise<Inserted<Alert>>;
  get(id: EntityId): Promise<Alert | null>;
  getByKey(alertKey: ContentHash): Promise<Alert | null>;
  getDocument(id: EntityId, lang: Lang): Promise<AlertDoc | null>;
  // A refresh overwrites the stored documents in place: the page shows the
  // latest reading of the story, with no per-update history.
  replaceDocuments(id: EntityId, documents: readonly AlertDoc[]): Promise<boolean>;
  listFeed(query: AlertFeedQuery): Promise<readonly Alert[]>;
}

export interface DeliveryPatch {
  readonly attempts?: number;
  readonly provider_message_id?: string | null;
  readonly last_error?: ErrorSummary | null;
  readonly next_attempt_at?: EpochMs | null;
  readonly suppressed_reason?: DeliverySuppressionReason | null;
}

export interface DeliveryTransition {
  readonly id: EntityId;
  readonly from: DeliveryState;
  readonly to: DeliveryState;
  readonly at: EpochMs;
  readonly expected?: ClaimVersion;
  readonly patch?: DeliveryPatch;
}

export interface DeliverySendRequest {
  readonly id: EntityId;
  readonly from: "pending" | "failed_retryable";
  readonly expected: ClaimVersion;
  readonly at: EpochMs;
  readonly minIntervalMinutes: number;
  readonly maxUpdatesPerItem: number;
}

export type DeliverySendClaim =
  | { readonly kind: "claimed"; readonly delivery: Delivery }
  | { readonly kind: "suppressed"; readonly reason: "update_limit" | "rate_limit" }
  | { readonly kind: "unavailable" };

export interface DeliveryRepo {
  get(id: EntityId): Promise<Delivery | null>;
  listByAlert(alertId: EntityId): Promise<readonly Delivery[]>;
  claimForSend(request: DeliverySendRequest): Promise<DeliverySendClaim>;
  // Conditional update on `state = from`. Resolves true only for the caller that won the claim.
  transition(transition: DeliveryTransition): Promise<boolean>;
  // Rows in `pending` or `failed_retryable` whose `next_attempt_at` has passed.
  listDue(now: EpochMs, limit: number): Promise<readonly Delivery[]>;
  listStale(query: StaleQuery<DeliveryState>): Promise<readonly Delivery[]>;
}

export interface DestinationRepo {
  // Idempotent on `name`.
  upsert(destination: Destination): Promise<Inserted<Destination>>;
  get(id: EntityId): Promise<Destination | null>;
  list(): Promise<readonly Destination[]>;
}

const DestinationPolicySchema = DestinationSchema.pick({
  lang: true,
  enabled: true,
  dry_run: true,
  min_tier: true,
  daily_budget: true,
  source_filters: true,
  quiet_hours: true,
});
export const DestinationPatchSchema = z
  .strictObject(DestinationPolicySchema.partial().shape)
  .refine((patch) => Object.values(patch).some((value) => value !== undefined));
export type DestinationPatch = z.infer<typeof DestinationPatchSchema>;
export const DestinationSummarySchema = DestinationPolicySchema.extend(
  DestinationSchema.pick({
    id: true,
    name: true,
    purpose: true,
    channel: true,
    created_at: true,
    updated_at: true,
  }).shape,
);
export type DestinationSummary = z.infer<typeof DestinationSummarySchema>;

export const AdminChangeSchema = z.strictObject({
  id: EntityIdSchema,
  actor: AuditLogEntrySchema.shape.actor,
  at: EpochMsSchema,
});
export type AdminChange = z.infer<typeof AdminChangeSchema>;

export interface AdminRepo {
  listDestinations(): Promise<readonly DestinationSummary[]>;
  patchDestination(id: EntityId, patch: DestinationPatch, change: AdminChange): Promise<boolean>;
  publishConfig(
    config: AppConfig,
    expectedVersion: number,
    change: AdminChange,
  ): Promise<ConfigVersion | null>;
}

export const BudgetRequestSchema = z.strictObject({
  workId: EntityIdSchema,
  day: DayKeySchema,
  scope: BudgetScopeSchema,
  amount: PositiveIntSchema,
  limit: NonNegativeIntSchema,
});
export type BudgetRequest = z.infer<typeof BudgetRequestSchema>;

export interface BudgetGrant {
  readonly granted: boolean;
  readonly entry: BudgetLedgerEntry;
}

export interface BudgetLedger {
  // A grant or denial is durable on (scope, workId), even after a day rollover.
  tryConsume(request: BudgetRequest): Promise<BudgetGrant>;
  get(day: DayKey, scope: BudgetScope): Promise<BudgetLedgerEntry | null>;
}

export interface AuditLog {
  // Append only. Idempotent on `id`.
  append(entry: AuditLogEntry): Promise<void>;
  listRecent(limit: number): Promise<readonly AuditLogEntry[]>;
}

export interface BlobRef {
  readonly key: string;
  readonly content_hash: ContentHash;
  readonly size: number;
}

export interface BlobPutOptions {
  readonly contentType: string;
}

export const BLOB_KEY_PREFIX = "sha256/";

export function blobKey(contentHash: ContentHash): string {
  return `${BLOB_KEY_PREFIX}${contentHash}`;
}

// Content addressed: the key is `blobKey` of the SHA-256 of the body, so a repeated put of the
// same bytes is a no-op that returns the same reference.
export interface BlobStore {
  put(body: Uint8Array | string, options: BlobPutOptions): Promise<BlobRef>;
  get(key: string): Promise<Uint8Array | null>;
  has(key: string): Promise<boolean>;
}

export interface ConfigStore {
  getCurrent(): Promise<ConfigVersion | null>;
  // Appends a new version; existing versions are never rewritten.
  publish(config: AppConfig, actor: string, at: EpochMs): Promise<ConfigVersion>;
}

export interface CacheSetOptions {
  readonly ttlSeconds: number;
}

// Eventually consistent, read-mostly storage. Never used for counters, locks, or dedup.
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: CacheSetOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

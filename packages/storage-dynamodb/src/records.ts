import { AlertDocSchema, type AlertDoc } from "@ai-moves/contracts/alert-doc";
import {
  AlertSchema,
  AnalysisSchema,
  AuditLogEntrySchema,
  ConfigVersionSchema,
  DeliverySchema,
  DestinationSchema,
  ItemRevisionSchema,
  ItemSchema,
  ItemSnapshotSchema,
  SourceSchema,
  type Alert,
  type Analysis,
  type AuditLogEntry,
  type ConfigVersion,
  type Delivery,
  type Destination,
  type Item,
  type ItemRevision,
  type ItemSnapshot,
  type Source,
} from "@ai-moves/contracts/entities";
import type { EntityId, EpochMs } from "@ai-moves/contracts/primitives";
import type { AlertKind } from "@ai-moves/contracts/states";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import {
  type Attributes,
  decodeDoc,
  isRecord,
  readBoolean,
  readJson,
  readNullableNumber,
  readNullableString,
  readNumber,
  readString,
  type Scalar,
} from "./codec.ts";
import { indexPartitions, type Key, keys, timeKey } from "./keys.ts";

// A record as read: the decoded value plus the version a conditional write must match.
export interface Loaded<T> {
  readonly value: T;
  readonly rev: number;
}

function record(
  key: Key,
  rev: number,
  doc: unknown,
  extra: Readonly<Record<string, Scalar>> = {},
): Attributes {
  return { pk: key.pk, sk: key.sk, rev, doc: JSON.stringify(doc), ...extra };
}

export function revOf(attributes: Attributes): number {
  return readNumber(attributes, "rev");
}

export function loaded<T>(
  attributes: Attributes,
  decode: (attributes: Attributes) => T,
): Loaded<T> {
  return { value: decode(attributes), rev: revOf(attributes) };
}

export function markerRecord(key: Key, ref: string): Attributes {
  return { pk: key.pk, sk: key.sk, rev: 1, ref };
}

export function markerRef(attributes: Attributes): string {
  return readString(attributes, "ref");
}

export const sourceRecord = (source: Source, rev: number): Attributes =>
  record(keys.source(source.id), rev, source);
export const decodeSource = (attributes: Attributes): Source =>
  decodeDoc(SourceSchema, attributes, "sources");

export interface PollSlot {
  readonly source_id: EntityId;
  readonly tick_bucket: number;
  readonly ready_at: EpochMs | null;
  readonly owner: EntityId | null;
}

export function pollRecord(poll: PollSlot, rev: number): Attributes {
  return {
    ...keys.poll(poll.source_id),
    rev,
    tick_bucket: poll.tick_bucket,
    ready_at: poll.ready_at,
    owner: poll.owner,
  };
}

export function decodePoll(attributes: Attributes): PollSlot {
  return {
    source_id: readString(attributes, "sk"),
    tick_bucket: readNumber(attributes, "tick_bucket"),
    ready_at: readNullableNumber(attributes, "ready_at"),
    owner: readNullableString(attributes, "owner"),
  };
}

export function itemRecord(item: Item, rev: number): Attributes {
  const inFeed = item.state === "alerted" || item.state === "feed_only";
  return record(keys.item(item.id), rev, item, {
    ...(inFeed
      ? { gsi1pk: indexPartitions.itemFeed, gsi1sk: timeKey(item.first_seen_at, item.id) }
      : {}),
    gsi2pk: indexPartitions.itemsBySourceState(item.source_id, item.state),
    gsi2sk: item.id,
    gsi3pk: indexPartitions.itemsByState(item.state),
    gsi3sk: timeKey(item.state_updated_at, item.id),
  });
}
export const decodeItem = (attributes: Attributes): Item =>
  decodeDoc(ItemSchema, attributes, "items");

export function snapshotRecord(snapshot: ItemSnapshot): Attributes {
  const doc: ItemSnapshot = {
    item_id: snapshot.item_id,
    sampled_at: snapshot.sampled_at,
    rank: snapshot.rank,
    points: snapshot.points,
    comments: snapshot.comments,
  };
  return record(keys.snapshot(snapshot.item_id, snapshot.sampled_at), 1, doc, {
    gsi1pk: indexPartitions.snapshots,
    gsi1sk: timeKey(snapshot.sampled_at, snapshot.item_id),
  });
}
export const decodeSnapshot = (attributes: Attributes): ItemSnapshot =>
  decodeDoc(ItemSnapshotSchema, attributes, "item_snapshots");

export function revisionRecord(revision: ItemRevision): Attributes {
  const doc: ItemRevision = {
    item_id: revision.item_id,
    content_hash: revision.content_hash,
    origin: revision.origin,
    blob_key: revision.blob_key,
    observed_at: revision.observed_at,
  };
  return record(keys.revision(revision.item_id, revision.content_hash), 1, doc);
}
export const decodeRevision = (attributes: Attributes): ItemRevision =>
  decodeDoc(ItemRevisionSchema, attributes, "item_revisions");

export interface AnalysisLease {
  readonly owner: EntityId | null;
  readonly expiresAt: EpochMs | null;
}

export function analysisRecord(analysis: Analysis, lease: AnalysisLease, rev: number): Attributes {
  const doc: Analysis = {
    id: analysis.id,
    item_id: analysis.item_id,
    stage: analysis.stage,
    input_hash: analysis.input_hash,
    prompt_version: analysis.prompt_version,
    lang: analysis.lang,
    model: analysis.model,
    config_version: analysis.config_version,
    status: analysis.status,
    output_json: analysis.output_json,
    blob_key: analysis.blob_key,
    usage_json: analysis.usage_json,
    error_code: analysis.error_code,
    created_at: analysis.created_at,
    updated_at: analysis.updated_at,
  };
  return record(keys.analysis(analysis.id), rev, doc, {
    lease_owner: lease.owner,
    lease_expires_at: lease.expiresAt,
  });
}
export const decodeAnalysis = (attributes: Attributes): Analysis =>
  decodeDoc(AnalysisSchema, attributes, "analyses");
export function decodeAnalysisLease(attributes: Attributes): AnalysisLease {
  return {
    owner: readNullableString(attributes, "lease_owner"),
    expiresAt: readNullableNumber(attributes, "lease_expires_at"),
  };
}

function alertDoc(alert: Alert): Alert {
  return {
    id: alert.id,
    alert_key: alert.alert_key,
    item_id: alert.item_id,
    analysis_id: alert.analysis_id,
    cluster_id: alert.cluster_id,
    tier: alert.tier,
    kind: alert.kind,
    decision: alert.decision,
    decision_reason_json: alert.decision_reason_json,
    created_at: alert.created_at,
  };
}

// The alert row also lists its deliveries and stored document languages, so `listByAlert` and
// `replaceDocuments` read them with one strongly consistent get instead of an index query.
export interface AlertMembers {
  readonly deliveryIds: readonly EntityId[];
  readonly documentLangs: readonly string[];
}

export function alertRecord(alert: Alert, members: AlertMembers, rev: number): Attributes {
  return record(keys.alert(alert.id), rev, alertDoc(alert), {
    delivery_ids: JSON.stringify(members.deliveryIds),
    doc_langs: JSON.stringify(members.documentLangs),
    gsi1pk: indexPartitions.alertFeed,
    gsi1sk: timeKey(alert.created_at, alert.id),
  });
}

function stringArray(attributes: Attributes, field: string): readonly string[] {
  const value = readJson(attributes, field, "alerts");
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new AppError("ROW_INVALID", {
      message: `Invalid stored attribute alerts.${field}`,
      context: { entity: "alerts", field },
    });
  }
  return value;
}

export function decodeAlertMembers(attributes: Attributes): AlertMembers {
  return {
    deliveryIds: stringArray(attributes, "delivery_ids"),
    documentLangs: stringArray(attributes, "doc_langs"),
  };
}

// Alerts never change after insert, so a copy under the item's partition stays exact and gives
// the per-item feed a strongly consistent read.
export function itemAlertRecord(alert: Alert): Attributes {
  return record(keys.itemAlert(alert.item_id, alert.created_at, alert.id), 1, alertDoc(alert));
}
export const decodeAlert = (attributes: Attributes): Alert =>
  decodeDoc(AlertSchema, attributes, "alerts");

export function alertDocumentRecord(document: AlertDoc): Attributes {
  return record(keys.alertDocument(document.alert_id, document.lang), 1, document);
}
export const decodeAlertDocument = (attributes: Attributes): AlertDoc =>
  decodeDoc(AlertDocSchema, attributes, "alert_documents");

// Denormalized from the alert at insert time so a transition can maintain the update ledger
// without reading the alert. `live` mirrors D1's `live_send_reserved`.
export interface DeliveryMeta {
  readonly live: boolean;
  readonly alertKind: AlertKind;
  readonly itemId: EntityId;
}

export function deliveryRecord(delivery: Delivery, meta: DeliveryMeta, rev: number): Attributes {
  const due = delivery.state === "pending" || delivery.state === "failed_retryable";
  return record(keys.delivery(delivery.id), rev, delivery, {
    live: meta.live,
    alert_kind: meta.alertKind,
    item_id: meta.itemId,
    ...(due
      ? {
          gsi2pk: indexPartitions.deliveriesDue,
          gsi2sk: timeKey(delivery.next_attempt_at ?? 0, delivery.id),
        }
      : {}),
    gsi3pk: indexPartitions.deliveriesByState(delivery.state),
    gsi3sk: timeKey(delivery.state_updated_at, delivery.id),
  });
}
export const decodeDelivery = (attributes: Attributes): Delivery =>
  decodeDoc(DeliverySchema, attributes, "deliveries");
export function decodeDeliveryMeta(attributes: Attributes): DeliveryMeta {
  const alertKind = readString(attributes, "alert_kind");
  if (alertKind !== "new" && alertKind !== "update") {
    throw new AppError("ROW_INVALID", {
      message: "Invalid stored attribute deliveries.alert_kind",
      context: { entity: "deliveries", field: "alert_kind" },
    });
  }
  return {
    live: readBoolean(attributes, "live"),
    alertKind,
    itemId: readString(attributes, "item_id"),
  };
}

export function destinationRecord(destination: Destination, rev: number): Attributes {
  const doc: Destination = {
    id: destination.id,
    name: destination.name,
    purpose: destination.purpose,
    channel: destination.channel,
    secret_ref: destination.secret_ref,
    lang: destination.lang,
    enabled: destination.enabled,
    dry_run: destination.dry_run,
    min_tier: destination.min_tier,
    source_filters: destination.source_filters,
    quiet_hours: destination.quiet_hours,
    created_at: destination.created_at,
    updated_at: destination.updated_at,
  };
  return record(keys.destination(destination.id), rev, doc);
}
export const decodeDestination = (attributes: Attributes): Destination =>
  decodeDoc(DestinationSchema, attributes, "destinations");

export function auditRecord(entry: AuditLogEntry): Attributes {
  const doc: AuditLogEntry = {
    id: entry.id,
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    detail_json: entry.detail_json,
    created_at: entry.created_at,
  };
  return record(keys.audit(entry.id), 1, doc, {
    gsi1pk: indexPartitions.auditLog,
    gsi1sk: timeKey(entry.created_at, entry.id),
  });
}
export const decodeAudit = (attributes: Attributes): AuditLogEntry =>
  decodeDoc(AuditLogEntrySchema, attributes, "audit_log");

export function configRecord(version: ConfigVersion): Attributes {
  return record(keys.config(version.version), 1, version);
}
export const decodeConfig = (attributes: Attributes): ConfigVersion =>
  decodeDoc(ConfigVersionSchema, attributes, "config_versions");

// The live-send reservations `claimForSend` decides on, kept in one strongly read record that
// every reserving or releasing write updates under a version condition. `recent` holds, per
// alert, the latest time one of its live deliveries became `sent` or `unknown`; those states are
// terminal, so only the two most recent distinct alerts can ever answer "the latest send of an
// alert other than this one".
export interface SendGate {
  readonly rev: number | null;
  readonly sending: ReadonlyMap<EntityId, EntityId>;
  readonly recent: readonly { readonly alert_id: EntityId; readonly at: EpochMs }[];
}

const RECENT_ALERTS_KEPT = 2;

function gateInvalid(field: string): AppError {
  return new AppError("ROW_INVALID", {
    message: `Invalid stored attribute send_gate.${field}`,
    context: { entity: "send_gate", field },
  });
}

export function decodeGate(attributes: Attributes | null): SendGate {
  if (attributes === null) return { rev: null, sending: new Map(), recent: [] };
  const storedSending = readJson(attributes, "sending", "send_gate");
  const storedRecent = readJson(attributes, "recent", "send_gate");
  if (!isRecord(storedSending)) throw gateInvalid("sending");
  const sending = new Map<EntityId, EntityId>();
  for (const [deliveryId, alertId] of Object.entries(storedSending)) {
    if (typeof alertId !== "string") throw gateInvalid("sending");
    sending.set(deliveryId, alertId);
  }
  if (!Array.isArray(storedRecent)) throw gateInvalid("recent");
  const recent = storedRecent.map((entry: unknown) => {
    const alertId = isRecord(entry) ? entry["alert_id"] : undefined;
    const at = isRecord(entry) ? entry["at"] : undefined;
    if (typeof alertId !== "string" || typeof at !== "number" || !Number.isSafeInteger(at)) {
      throw gateInvalid("recent");
    }
    return { alert_id: alertId, at };
  });
  return { rev: revOf(attributes), sending, recent };
}

export function gateRecord(gate: SendGate): Attributes {
  return {
    ...keys.sendGate,
    rev: (gate.rev ?? 0) + 1,
    sending: JSON.stringify(Object.fromEntries(gate.sending)),
    recent: JSON.stringify(gate.recent),
  };
}

export function reserveSending(gate: SendGate, deliveryId: EntityId, alertId: EntityId): SendGate {
  return { ...gate, sending: new Map(gate.sending).set(deliveryId, alertId) };
}

export function releaseSending(
  gate: SendGate,
  deliveryId: EntityId,
  finished: { readonly alert_id: EntityId; readonly at: EpochMs } | null,
): SendGate {
  const sending = new Map(gate.sending);
  sending.delete(deliveryId);
  if (finished === null) return { ...gate, sending };
  const latest = new Map<EntityId, EpochMs>();
  for (const entry of [...gate.recent, finished]) {
    latest.set(entry.alert_id, Math.max(latest.get(entry.alert_id) ?? entry.at, entry.at));
  }
  const recent = [...latest.entries()]
    .map(([alert_id, at]) => ({ alert_id, at }))
    .toSorted((left, right) => right.at - left.at)
    .slice(0, RECENT_ALERTS_KEPT);
  return { ...gate, sending, recent };
}

// Per item: how many live-reserved deliveries each `update` alert holds.
export interface UpdateLedger {
  readonly rev: number | null;
  readonly alerts: ReadonlyMap<EntityId, number>;
}

export function decodeLedger(attributes: Attributes | null): UpdateLedger {
  if (attributes === null) return { rev: null, alerts: new Map() };
  const stored = readJson(attributes, "alerts", "update_ledger");
  const invalid = new AppError("ROW_INVALID", {
    message: "Invalid stored attribute update_ledger.alerts",
    context: { entity: "update_ledger", field: "alerts" },
  });
  if (!isRecord(stored)) throw invalid;
  const alerts = new Map<EntityId, number>();
  for (const [alertId, count] of Object.entries(stored)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) throw invalid;
    alerts.set(alertId, count);
  }
  return { rev: revOf(attributes), alerts };
}

export function ledgerRecord(itemId: EntityId, ledger: UpdateLedger): Attributes {
  return {
    ...keys.updateLedger(itemId),
    rev: (ledger.rev ?? 0) + 1,
    alerts: JSON.stringify(Object.fromEntries(ledger.alerts)),
  };
}

export function adjustLedger(ledger: UpdateLedger, alertId: EntityId, delta: number): UpdateLedger {
  const alerts = new Map(ledger.alerts);
  const count = (alerts.get(alertId) ?? 0) + delta;
  if (count > 0) alerts.set(alertId, count);
  else alerts.delete(alertId);
  return { ...ledger, alerts };
}

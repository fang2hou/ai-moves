import type { EntityId, EpochMs, Lang } from "@ai-moves/contracts/primitives";

// Every key value the adapter writes is built here, so the layout documented in the README has
// one source.

export interface Key {
  readonly pk: string;
  readonly sk: string;
}

export const ROOT = "#";

const EPOCH_WIDTH = 16;
// Sorts after every digit and `#`, so it closes a range over padded numbers.
export const RANGE_END = "~";

export function pad(value: number): string {
  return String(value).padStart(EPOCH_WIDTH, "0");
}

// `(at, id)` as one string: fixed-width digits keep numeric order, and the ids are ASCII, so a
// byte comparison of the whole key matches the SQL row-value comparison `(at, id) < (?, ?)`.
export function timeKey(at: EpochMs, id: string): string {
  return `${pad(at)}#${id}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type UniqueNamespace =
  | "source_key"
  | "item_external_key"
  | "analysis_key"
  | "alert_key"
  | "delivery_idempotency_key"
  | "destination_name";

// Natural keys can exceed DynamoDB's 2048-byte partition key limit, so markers key on a digest.
export async function uniqueKey(namespace: UniqueNamespace, value: string): Promise<Key> {
  return { pk: `UNIQUE#${namespace}#${await sha256Hex(value)}`, sk: ROOT };
}

export const keys = {
  source: (id: EntityId): Key => ({ pk: "SOURCES", sk: id }),
  sourcePartition: "SOURCES",
  poll: (sourceId: EntityId): Key => ({ pk: "POLLS", sk: sourceId }),
  pollPartition: "POLLS",
  item: (id: EntityId): Key => ({ pk: `ITEM#${id}`, sk: ROOT }),
  itemPartition: (id: EntityId): string => `ITEM#${id}`,
  snapshot: (itemId: EntityId, sampledAt: EpochMs): Key => ({
    pk: `ITEM#${itemId}`,
    sk: `SNAP#${pad(sampledAt)}`,
  }),
  snapshotPrefix: "SNAP#",
  revision: (itemId: EntityId, contentHash: string): Key => ({
    pk: `ITEM#${itemId}`,
    sk: `REV#${contentHash}`,
  }),
  revisionPrefix: "REV#",
  itemAlert: (itemId: EntityId, createdAt: EpochMs, alertId: EntityId): Key => ({
    pk: `ITEM#${itemId}`,
    sk: `ALERT#${timeKey(createdAt, alertId)}`,
  }),
  itemAlertPrefix: "ALERT#",
  updateLedger: (itemId: EntityId): Key => ({ pk: `ITEM#${itemId}`, sk: "UPDATES" }),
  analysis: (id: EntityId): Key => ({ pk: `ANALYSIS#${id}`, sk: ROOT }),
  alert: (id: EntityId): Key => ({ pk: `ALERT#${id}`, sk: ROOT }),
  alertDocument: (alertId: EntityId, lang: Lang): Key => ({
    pk: `ALERT#${alertId}`,
    sk: `DOC#${lang}`,
  }),
  delivery: (id: EntityId): Key => ({ pk: `DELIVERY#${id}`, sk: ROOT }),
  sendGate: { pk: "SEND_GATE", sk: ROOT } as Key,
  destination: (id: EntityId): Key => ({ pk: "DESTINATIONS", sk: id }),
  destinationPartition: "DESTINATIONS",
  audit: (id: EntityId): Key => ({ pk: `AUDIT#${id}`, sk: ROOT }),
  config: (version: number): Key => ({ pk: "CONFIG", sk: pad(version) }),
  configPartition: "CONFIG",
} as const;

// Partition values of the overloaded global secondary indexes.
export const indexPartitions = {
  itemFeed: "ITEM_FEED",
  alertFeed: "ALERT_FEED",
  auditLog: "AUDIT_LOG",
  snapshots: "SNAPSHOTS",
  itemsBySourceState: (sourceId: EntityId, state: string): string =>
    `ITEM_SOURCE#${sourceId}#${state}`,
  deliveriesDue: "DELIVERY_DUE",
  itemsByState: (state: string): string => `ITEM_STATE#${state}`,
  deliveriesByState: (state: string): string => `DELIVERY_STATE#${state}`,
} as const;

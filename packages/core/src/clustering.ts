import type { ItemKind } from "@ai-moves/contracts/states";

import { stableKey } from "./idempotency.ts";

export interface ClusterIdentity {
  readonly kind: ItemKind;
  readonly externalKey: string;
  readonly title: string;
  readonly url: string | null;
}

export function normalizeClusterText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

export function canonicalClusterUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLocaleLowerCase("en-US");
  const entries = [...url.searchParams.keys()];
  for (const key of entries) {
    if (key.startsWith("utm_")) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

export function clusterKey(identity: ClusterIdentity): string {
  const title = normalizeClusterText(identity.title);
  const source =
    identity.url === null
      ? normalizeClusterText(identity.externalKey)
      : canonicalClusterUrl(identity.url);
  return `cluster:${stableKey(identity.kind, source, title)}`;
}

export function chooseClusterId(keys: readonly string[]): string {
  if (keys.length === 0) return "";
  return keys.reduce((minimum, key) => (key < minimum ? key : minimum));
}

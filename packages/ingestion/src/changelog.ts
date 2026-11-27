import type { AppConfig } from "@ai-moves/contracts/config";
import type { Item } from "@ai-moves/contracts/entities";
import { blobKey, type BlobStore, type ItemRevisionRepo } from "@ai-moves/contracts/ports/storage";
import type { RevisionOrigin } from "@ai-moves/contracts/states";

import { observeItem, recordScore, type ObservationState } from "./observations.ts";

// One release, one tag section, or one changelog page. Both the GitHub reader and the
// web-page reader produce these, so the observation below is shared.
export interface ChangelogEntry {
  readonly key: string;
  readonly origin: RevisionOrigin;
  readonly title: string;
  readonly notes: string;
  readonly url: string;
  readonly version: string | null;
  readonly publishedAt: number | null;
  readonly historical: boolean;
}

const TEXT_TYPE = "text/plain; charset=utf-8";

export interface ChangelogObservePorts {
  readonly blobs: Pick<BlobStore, "get" | "put">;
  readonly revisions: Pick<ItemRevisionRepo, "insertIfAbsent" | "listByItem">;
}

// Resolves false when a revision could not be settled, so the caller keeps the
// previous cursor and reads the same entries again on the next poll.
export async function observeChangelog(
  state: ObservationState,
  ports: ChangelogObservePorts,
  sourceId: string,
  entries: readonly ChangelogEntry[],
  config: Pick<AppConfig, "changelog" | "delivery">,
  candidates: Set<string>,
): Promise<boolean> {
  let revisit = false;
  for (const entry of entries) {
    if (!state.beforeExpiry()) return false;
    const item = await observeItem(state, {
      source_id: sourceId,
      external_key: entry.key,
      kind: "changelog",
      url: entry.url,
      title: entry.title.slice(0, 1000),
      published_at: entry.publishedAt,
    });
    const notes = normalizeNotes(entry.notes);
    if (!state.beforeExpiry()) return false;
    const ref = await ports.blobs.put(notes, { contentType: TEXT_TYPE });
    const cutoff = state.sampledAt - config.delivery.expiry_hours.changelog * 3_600_000;
    const timely = !entry.historical && (entry.publishedAt === null || entry.publishedAt > cutoff);
    if (item.content_hash === ref.content_hash) {
      if (item.state === "candidate" && item.score_json?.computed_at === state.sampledAt)
        candidates.add(item.id);
      continue;
    }

    if (!state.beforeExpiry()) return false;
    await ports.revisions.insertIfAbsent({
      item_id: item.id,
      content_hash: ref.content_hash,
      origin: entry.origin,
      blob_key: ref.key,
      observed_at: state.sampledAt,
    });
    if (isBusy(item)) {
      revisit = true;
      continue;
    }
    const revisions = await ports.revisions.listByItem(item.id);
    const priorNotes =
      item.content_hash === null ? null : await ports.blobs.get(blobKey(item.content_hash));
    const oldNotes = priorNotes === null ? "" : new TextDecoder().decode(priorNotes);
    const prefix = commonPrefix(oldNotes, notes);
    const suffix = commonSuffix(oldNotes, notes, prefix);
    const meaningful =
      Math.max(oldNotes.length, notes.length) - prefix - suffix >=
      config.changelog.min_revision_diff_chars;
    const target = changelogTarget(item, timely, meaningful);
    const saved = await recordScore(state, item, target, {
      content_hash: ref.content_hash,
      revision: revisions.length,
      score_json: { kind: "changelog", computed_at: state.sampledAt },
    });
    if (!saved) revisit = true;
    else if (target === "candidate" && item.state !== "candidate") candidates.add(item.id);
  }
  // A validator cannot advance past a revision whose item is still being analyzed.
  return !revisit;
}

function isBusy(item: Item): boolean {
  return (
    item.content_hash !== null &&
    (item.state === "candidate" ||
      item.state === "triaging" ||
      item.state === "triaged_pass" ||
      item.state === "analyzing" ||
      item.state === "analyzed")
  );
}

function changelogTarget(item: Item, interesting: boolean, meaningful: boolean): Item["state"] {
  if (item.state === "discovered") return interesting ? "candidate" : "tracking";
  if (!interesting) return item.state;
  if (item.state === "tracking") return "candidate";
  if (
    meaningful &&
    (item.state === "alerted" || (item.state === "triaged_reject" && item.attempts === 1))
  )
    return "candidate";
  return item.state;
}

function normalizeNotes(notes: string): string {
  return notes
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+(?=\n|$)/gu, "")
    .trim();
}

function commonPrefix(left: string, right: string): number {
  let length = 0;
  while (length < Math.min(left.length, right.length) && left[length] === right[length]) length++;
  return length;
}

function commonSuffix(left: string, right: string, prefix: number): number {
  const available = Math.min(left.length, right.length) - prefix;
  let length = 0;
  while (length < available && left[left.length - 1 - length] === right[right.length - 1 - length])
    length++;
  return length;
}

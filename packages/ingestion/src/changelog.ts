import type { AppConfig } from "@ai-moves/contracts/config";
import type { Item } from "@ai-moves/contracts/entities";
import { blobKey, type BlobStore, type ItemRevisionRepo } from "@ai-moves/contracts/ports/storage";
import type { RevisionOrigin } from "@ai-moves/contracts/states";
import { scoreChangelog, type ChangelogSignalInput } from "@ai-moves/core/scoring/changelog";

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
  readonly prerelease: boolean;
  readonly publishedAt: number | null;
  readonly historical: boolean;
}

const TEXT_TYPE = "text/plain; charset=utf-8";
const TRACKED_BACKFILL_MS = 24 * 3_600_000;

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
  config: Pick<AppConfig, "changelog" | "delivery" | "push">,
  candidates: Set<string>,
): Promise<boolean> {
  let revisit = false;
  const notesByEntry = entries.map((entry) => normalizeNotes(entry.notes));
  const lengthTotal = notesByEntry.reduce((total, notes) => total + notes.length, 0);
  const lengthSquares = notesByEntry.reduce((total, notes) => total + notes.length ** 2, 0);
  for (const [index, entry] of entries.entries()) {
    if (!state.beforeExpiry()) return false;
    const item = await observeItem(state, {
      source_id: sourceId,
      external_key: entry.key,
      kind: "changelog",
      url: entry.url,
      title: entry.title.slice(0, 1000),
      published_at: entry.publishedAt,
    });
    const notes = notesByEntry[index] ?? "";
    if (!state.beforeExpiry()) return false;
    const ref = await ports.blobs.put(notes, { contentType: TEXT_TYPE });
    const approveAll = config.push.changelog.approve_all;
    const cutoff = state.sampledAt - config.delivery.expiry_hours.changelog * 3_600_000;
    const timely = !entry.historical && (entry.publishedAt === null || entry.publishedAt > cutoff);
    // Under `approve_all`, a release left in `tracking` before the switch (it had no scoring
    // signal) is scored again so it becomes a candidate. Only a release from the last day is
    // picked up this way, so turning the switch on does not post a week of old releases.
    const recentlyTracked =
      approveAll &&
      item.state === "tracking" &&
      entry.publishedAt !== null &&
      entry.publishedAt > state.sampledAt - TRACKED_BACKFILL_MS;
    if (item.content_hash === ref.content_hash && !recentlyTracked) {
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
    const changed = notes.slice(prefix, notes.length - suffix);
    const peers = notesByEntry.length - 1;
    const peerMean = peers < 2 ? 0 : (lengthTotal - notes.length) / peers;
    const peerDeviation =
      peers < 2
        ? 0
        : Math.sqrt(Math.max(0, (lengthSquares - notes.length ** 2) / peers - peerMean ** 2));
    const zScore = peerDeviation === 0 ? 0 : (notes.length - peerMean) / peerDeviation;
    const score = scoreChangelog({
      signals: changelogSignals(entry, changed, zScore > config.changelog.long_notes_z_score),
      computedAt: state.sampledAt,
      config: config.changelog,
    });
    const meaningful =
      Math.max(oldNotes.length, notes.length) - prefix - suffix >=
      config.changelog.min_revision_diff_chars;
    const target = changelogTarget(item, timely && (approveAll || score.prior > 0), meaningful);
    const saved = await recordScore(state, item, target, {
      content_hash: ref.content_hash,
      revision: revisions.length,
      score_json: score,
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

function changelogSignals(
  entry: ChangelogEntry,
  added: string,
  longNotes: boolean,
): readonly ChangelogSignalInput[] {
  const signals: ChangelogSignalInput[] = [];
  const version = entry.version === null ? null : semver(entry.version);
  if (version?.patch === 0 && entry.version !== null)
    signals.push({ signal: "semver_minor_or_major", evidence: [entry.version.slice(0, 500)] });
  if (entry.prerelease) signals.push({ signal: "prerelease", evidence: [] });

  // Release notes say "Added X", not "Added support for X". Matching only the
  // formal phrasings left pages full of new features scoring as fixes only.
  const newSurface =
    /(?:^|\n)[ \t]*(?:[-*•][ \t]*)?(?:\*\*)?(?:added|new)\b|\b(?:new (?:api|command|feature|endpoint|setting|flag|option)|introduc(?:e|es|ed|ing)|add(?:s|ed)? support)\b/iu.exec(
      added,
    );
  const breaking =
    /\b(?:breaking changes?|removed support|incompatible|no longer|deprecat(?:e|es|ed|ing))\b/iu.exec(
      added,
    );
  const defaultChange =
    /\b(?:new default|defaults? to|default (?:is now|changed|behavior)|by default now|now (?:asks|refuses|requires))\b/iu.exec(
      added,
    );
  if (newSurface !== null) signals.push({ signal: "new_surface", evidence: [newSurface[0]] });
  if (breaking !== null) signals.push({ signal: "breaking", evidence: [breaking[0]] });
  if (defaultChange !== null)
    signals.push({ signal: "default_change", evidence: [defaultChange[0]] });
  if (longNotes && added.length > 0) {
    signals.push({ signal: "long_notes", evidence: [added.slice(0, 500)] });
  }
  if (
    signals.length === Number(entry.prerelease) &&
    /\b(?:bug fixes?|fix(?:ed|es)?|dependencies|deps)\b/iu.test(added)
  )
    signals.push({ signal: "fix_or_deps_only", evidence: [] });
  return signals;
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

export function semver(version: string): { patch: number; prerelease: boolean } | null {
  const match = /^v?\d+\.\d+\.(\d+)(-[\w.-]+)?(?:\+[\w.-]+)?$/iu.exec(version);
  return match === null ? null : { patch: Number(match[1]), prerelease: match[2] !== undefined };
}

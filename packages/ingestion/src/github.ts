import type { AppConfig } from "@ai-moves/contracts/config";
import type { Item, SourceConfig, SourceCursor } from "@ai-moves/contracts/entities";
import type { GitHubClient } from "@ai-moves/contracts/ports/sources";
import { blobKey, type BlobStore, type ItemRevisionRepo } from "@ai-moves/contracts/ports/storage";
import type { RevisionOrigin } from "@ai-moves/contracts/states";
import { scoreChangelog, type ChangelogSignalInput } from "@ai-moves/core/scoring/changelog";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import { observeItem, recordScore, type ObservationState } from "./observations.ts";

type GitHubSource = Extract<SourceConfig, { kind: "github_repo" }>;
type GitHubCursor = Extract<SourceCursor, { kind: "github_repo" }>;

interface ChangelogEntry {
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

export interface GitHubPoll {
  readonly entries: readonly ChangelogEntry[];
  readonly cursor: GitHubCursor;
  readonly previous: GitHubCursor;
}

const MAX_CURSOR_VERSIONS = 10;
const TEXT_TYPE = "text/plain; charset=utf-8";

export async function readGitHub(
  github: GitHubClient,
  source: GitHubSource,
  previous: SourceCursor,
): Promise<GitHubPoll> {
  if (previous.kind !== "github_repo") throw new AppError("ROW_INVALID");
  const cursor = { ...previous };
  const repoPath = `${source.owner.toLowerCase()}/${source.repo.toLowerCase()}`;
  const repoUrl = `https://github.com/${repoPath}`;

  if (source.strategy === "release_first") {
    const releases = await github.listReleases(source, { etag: previous.releases_etag });
    if (releases.status === "not_modified") return { entries: [], cursor, previous };
    const entries: ChangelogEntry[] = [];
    for (const release of releases.value) {
      if (release.draft) continue;
      entries.push({
        key: `${repoPath}:version:${release.tag}`,
        origin: "release",
        title: release.name?.trim() || `${source.repo} ${release.tag}`,
        notes: release.body ?? "",
        url: release.url,
        version: release.tag,
        prerelease: release.prerelease,
        publishedAt: release.published_at,
        historical:
          release.published_at === null &&
          entries.length > 0 &&
          previous.known_versions.length === 0,
      });
    }
    cursor.releases_etag = entries.length === 0 ? null : releases.etag;
    if (entries.length > 0) {
      cursor.tags_etag = null;
      cursor.known_versions = cursorVersions(entries.flatMap(({ version }) => version ?? []));
      return { entries, cursor, previous };
    }
  }

  if (source.strategy !== "changelog_file") {
    const tags = await github.listTags(source, { etag: previous.tags_etag });
    const versions =
      tags.status === "modified" ? tags.value.map(({ name }) => name) : previous.known_versions;
    if (tags.status === "modified") {
      cursor.tags_etag = versions.length === 0 ? null : tags.etag;
      cursor.known_versions = cursorVersions(versions);
    }
    if (versions.length > 0) {
      const file =
        source.strategy === "tags_plus_changelog"
          ? await github.getFile(source, source.changelog_path, { etag: null })
          : null;
      const notes =
        file?.status === "modified" && file.value !== null
          ? sectionsByVersion(file.value.text)
          : null;
      if (file?.status === "modified") cursor.changelog_sha = file.value?.sha ?? null;
      const changedNotes = cursor.changelog_sha !== previous.changelog_sha;
      if (tags.status === "not_modified" && !changedNotes) return { entries: [], cursor, previous };
      const known = new Set(previous.known_versions);
      const entries: ChangelogEntry[] = [];
      for (const version of versions) {
        const section = notes?.get(version.replace(/^v/iu, ""));
        if (section === undefined && known.has(version)) continue;
        entries.push({
          key: `${repoPath}:version:${version}`,
          origin: "tag",
          title: `${source.repo} ${version}`,
          notes: section ?? "",
          url: `${repoUrl}/releases/tag/${encodeURIComponent(version)}`,
          version,
          prerelease: semver(version)?.prerelease ?? false,
          publishedAt: null,
          historical: entries.length > 0 && previous.known_versions.length === 0,
        });
      }
      return { entries, cursor, previous };
    }
  }

  // The cursor stores a content SHA, not a GitHub HTTP validator.
  const file = await github.getFile(source, source.changelog_path, { etag: null });
  if (file.status === "not_modified") return { entries: [], cursor, previous };
  cursor.changelog_sha = file.value?.sha ?? null;
  if (file.value === null || file.value.sha === previous.changelog_sha)
    return { entries: [], cursor, previous };
  const path = file.value.path.split("/").map(encodeURIComponent).join("/");
  const latest = sectionsByVersion(file.value.text).entries().next().value;
  const entry: ChangelogEntry = {
    key: `${repoPath}:file:${source.changelog_path}`,
    origin: "changelog_file",
    title: `${source.repo} changelog`,
    notes: file.value.text,
    url: `${repoUrl}/blob/HEAD/${path}`,
    version: latest?.[0] ?? null,
    prerelease: latest === undefined ? false : (semver(latest[0])?.prerelease ?? false),
    publishedAt: null,
    historical: false,
  };
  return { entries: [entry], cursor, previous };
}

export async function observeGitHub(
  state: ObservationState,
  ports: {
    readonly blobs: Pick<BlobStore, "get" | "put">;
    readonly revisions: Pick<ItemRevisionRepo, "insertIfAbsent" | "listByItem">;
  },
  sourceId: string,
  poll: GitHubPoll,
  config: Pick<AppConfig, "changelog" | "delivery">,
  candidates: Set<string>,
): Promise<GitHubCursor> {
  let revisit = false;
  const notesByEntry = poll.entries.map((entry) => normalizeNotes(entry.notes));
  const lengthTotal = notesByEntry.reduce((total, notes) => total + notes.length, 0);
  const lengthSquares = notesByEntry.reduce((total, notes) => total + notes.length ** 2, 0);
  for (const [index, entry] of poll.entries.entries()) {
    if (!state.beforeExpiry()) return poll.previous;
    const item = await observeItem(state, {
      source_id: sourceId,
      external_key: `github:${entry.key}`,
      kind: "changelog",
      url: entry.url,
      title: entry.title.slice(0, 1000),
      published_at: entry.publishedAt,
    });
    const notes = notesByEntry[index] ?? "";
    if (!state.beforeExpiry()) return poll.previous;
    const ref = await ports.blobs.put(notes, { contentType: TEXT_TYPE });
    if (item.content_hash === ref.content_hash) {
      if (item.state === "candidate" && item.score_json?.computed_at === state.sampledAt)
        candidates.add(item.id);
      continue;
    }

    if (!state.beforeExpiry()) return poll.previous;
    await ports.revisions.insertIfAbsent({
      item_id: item.id,
      content_hash: ref.content_hash,
      origin: entry.origin,
      r2_key: ref.key,
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
    const cutoff = state.sampledAt - config.delivery.expiry_hours.changelog * 3_600_000;
    const timely = !entry.historical && (entry.publishedAt === null || entry.publishedAt > cutoff);
    const target = githubTarget(item, timely && score.prior > 0, meaningful);
    const saved = await recordScore(state, item, target, {
      content_hash: ref.content_hash,
      revision: revisions.length,
      score_json: score,
    });
    if (!saved) revisit = true;
    else if (target === "candidate" && item.state !== "candidate") candidates.add(item.id);
  }
  // A validator cannot advance past a revision whose item is still being analyzed.
  return revisit ? poll.previous : poll.cursor;
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

function githubTarget(item: Item, interesting: boolean, meaningful: boolean): Item["state"] {
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

function cursorVersions(versions: readonly string[]): string[] {
  return versions.filter((version) => version.length <= 128).slice(0, MAX_CURSOR_VERSIONS);
}

function normalizeNotes(notes: string): string {
  return notes
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+(?=\n|$)/gu, "")
    .trim();
}

function sectionsByVersion(notes: string): Map<string, string> {
  const sections = new Map<string, string>();
  const headings = /^#{1,6}[ \t]+\[?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:[\s\])]|$)/gimu;
  let previous: { version: string; offset: number } | undefined;
  for (const heading of notes.matchAll(headings)) {
    const offset = heading.index;
    const version = heading[1];
    if (version === undefined) continue;
    if (previous !== undefined)
      sections.set(previous.version, notes.slice(previous.offset, offset));
    previous = { version, offset: notes.indexOf("\n", offset) + 1 };
    if (previous.offset === 0) break;
  }
  if (previous !== undefined && previous.offset !== 0)
    sections.set(previous.version, notes.slice(previous.offset));
  return sections;
}

function semver(version: string): { patch: number; prerelease: boolean } | null {
  const match = /^v?\d+\.\d+\.(\d+)(-[\w.-]+)?(?:\+[\w.-]+)?$/iu.exec(version);
  return match === null ? null : { patch: Number(match[1]), prerelease: match[2] !== undefined };
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

  const newSurface =
    /\b(?:new (?:api|command|feature|endpoint)|introduc(?:e|es|ed|ing)|add(?:s|ed)? support)\b/iu.exec(
      added,
    );
  const breaking = /\b(?:breaking changes?|removed support|incompatible)\b/iu.exec(added);
  const defaultChange =
    /\b(?:new default|default (?:is now|changed|behavior)|by default now)\b/iu.exec(added);
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

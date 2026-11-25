import type { SourceConfig, SourceCursor } from "@ai-moves/contracts/entities";
import type { GitHubClient } from "@ai-moves/contracts/ports/sources";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import type { ChangelogEntry } from "./changelog.ts";
import { semver } from "./changelog.ts";

type GitHubSource = Extract<SourceConfig, { kind: "github_repo" }>;
type GitHubCursor = Extract<SourceCursor, { kind: "github_repo" }>;

export interface GitHubPoll {
  readonly entries: readonly ChangelogEntry[];
  readonly cursor: GitHubCursor;
  readonly previous: GitHubCursor;
}

const MAX_CURSOR_VERSIONS = 10;

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
        key: `github:${repoPath}:version:${release.tag}`,
        origin: "release",
        // A release named only for its tag says nothing in a list of several
        // projects, so the repository name leads unless it is already there.
        title: releaseTitle(source.repo, release.name, release.tag),
        notes: release.body ?? "",
        url: release.url,
        version: release.tag,
        prerelease: release.prerelease,
        publishedAt: release.published_at,
        // A first read of a repository sees its whole release list. Only the newest
        // release is news; the rest are recorded and left alone, whatever their dates
        // say, so a cold start only analyzes the newest release.
        historical: entries.length > 0 && previous.known_versions.length === 0,
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
          key: `github:${repoPath}:version:${version}`,
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
    key: `github:${repoPath}:file:${source.changelog_path}`,
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

function releaseTitle(repo: string, name: string | null, tag: string): string {
  const given = name?.trim() ?? "";
  if (given.toLowerCase().includes(repo.toLowerCase())) return given;
  return `${repo} ${given || tag}`;
}

function cursorVersions(versions: readonly string[]): string[] {
  return versions.filter((version) => version.length <= 128).slice(0, MAX_CURSOR_VERSIONS);
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

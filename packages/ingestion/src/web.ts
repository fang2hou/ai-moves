import type { SourceConfig, SourceCursor } from "@ai-moves/contracts/entities";
import type { WebFetcher } from "@ai-moves/contracts/ports/sources";
import type { Telemetry } from "@ai-moves/contracts/ports/runtime";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import type { ChangelogEntry } from "./changelog.ts";
import { parseChangelog } from "./parsers/registry.ts";
import type { ChangelogSection } from "./parsers/section.ts";

type WebPageSource = Extract<SourceConfig, { kind: "web_page" }>;
type WebPageCursor = Extract<SourceCursor, { kind: "web_page" }>;

export interface WebPagePoll {
  readonly entries: readonly ChangelogEntry[];
  readonly cursor: WebPageCursor;
  readonly previous: WebPageCursor;
}

// One release on the page is one item, so each version is read and published on its own
// rather than as a slice of a page that spans months. A first read takes only the newest
// release of each followed surface; later reads take everything published above that
// surface's high-water mark. One mark for the whole page would miss a new CLI release,
// because the page lists every app release before the first CLI one.
export async function readWebPage(
  web: WebFetcher,
  source: WebPageSource,
  previous: SourceCursor,
  telemetry: Pick<Telemetry, "count">,
): Promise<WebPagePoll> {
  if (previous.kind !== "web_page") throw new AppError("ROW_INVALID");
  const document = await web.fetchText(source.fetch_url);
  if (document.content_hash === previous.content_hash) {
    return { entries: [], cursor: previous, previous };
  }
  const watched = new Set(source.surfaces);
  const all = parseChangelog(source.page_url, document.text);
  // A suite publishes its app, CLI, SDK and IDE releases on one page; only the
  // named surfaces are followed, and the high-water mark moves along the ones
  // that are.
  const sections =
    watched.size === 0
      ? all
      : all.filter((section) => section.surface !== null && watched.has(section.surface));
  if (sections.length === 0) {
    // Nothing on the page reads as a followed release, which is what a redesign or a
    // renamed heading leaves, so nothing is published: read whole, the page would be one
    // item holding every release on it. The cursor is kept, so the marks wait for the page
    // to split again.
    telemetry.count("pipeline.poll.unsplit", 1, { source: source.label });
    return { entries: [], cursor: previous, previous };
  }

  const seen = new Map(previous.latest_markers.map(({ surface, marker }) => [surface, marker]));
  const bySurface = new Map<string, ChangelogSection[]>();
  for (const section of sections) {
    const key = section.surface ?? "";
    const group = bySurface.get(key);
    if (group === undefined) bySurface.set(key, [section]);
    else group.push(section);
  }

  const fresh: ChangelogSection[] = [];
  const marks: { surface: string; marker: string }[] = [];
  for (const [surface, group] of bySurface) {
    const newest = group[0];
    if (newest === undefined) continue;
    marks.push({ surface, marker: newest.marker });
    const mark = seen.get(surface);
    const index = group.findIndex((one) => one.marker === mark);
    // Re-observe the newest release when it may have received an in-place notes edit.
    fresh.push(...(index <= 0 ? [newest] : group.slice(0, index)));
  }

  return {
    entries: fresh.map((section) => entry(source, title(source.label, section.label), section)),
    cursor: { kind: "web_page", content_hash: document.content_hash, latest_markers: marks },
    previous,
  };
}

// A bare version number says nothing in a list of several products, so the source
// supplies the name. A label that already names the product stands on its own.
function title(label: string, section: string): string {
  return /^v?\d/u.test(section) ? `${label} ${section}` : section;
}

function entry(source: WebPageSource, heading: string, release: ChangelogSection): ChangelogEntry {
  return {
    key: `web:${source.page_url}#${release.marker}`,
    origin: "changelog_file",
    title: heading,
    notes: release.notes,
    url: source.page_url,
    version: release.version,
    prerelease: false,
    publishedAt: release.publishedAt,
    historical: false,
  };
}

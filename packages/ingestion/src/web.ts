import type { SourceConfig, SourceCursor } from "@ai-moves/contracts/entities";
import type { WebFetcher } from "@ai-moves/contracts/ports/sources";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import type { ChangelogEntry } from "./changelog.ts";
import { splitChangelog, type ChangelogSection } from "./sections.ts";

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
): Promise<WebPagePoll> {
  if (previous.kind !== "web_page") throw new AppError("ROW_INVALID");
  const document = await web.fetchText(source.fetch_url);
  if (document.content_hash === previous.content_hash) {
    return { entries: [], cursor: previous, previous };
  }
  const watched = new Set(source.surfaces);
  const all = splitChangelog(document.text);
  // A suite publishes its app, CLI, SDK and IDE releases on one page; only the
  // named surfaces are followed, and the high-water mark moves along the ones
  // that are.
  const sections =
    watched.size === 0
      ? all
      : all.filter((section) => section.surface !== null && watched.has(section.surface));
  if (sections.length === 0) {
    // No release boundary was recognised, so the page is read whole and its revisions
    // carry the changes.
    return {
      entries: [
        entry(source, `${source.label} changelog`, document.text, {
          version: null,
          publishedAt: null,
        }),
      ],
      cursor: { kind: "web_page", content_hash: document.content_hash, latest_markers: [] },
      previous,
    };
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
    const index = mark === undefined ? 0 : group.findIndex((one) => one.marker === mark);
    fresh.push(...(index <= 0 ? [newest] : group.slice(0, index)));
  }

  return {
    entries: fresh.map((section) =>
      entry(source, title(source.label, section.label), section.notes, section, section.marker),
    ),
    cursor: { kind: "web_page", content_hash: document.content_hash, latest_markers: marks },
    previous,
  };
}

// A bare version number says nothing in a list of several products, so the source
// supplies the name. A label that already names the product stands on its own.
function title(label: string, section: string): string {
  return /^v?\d/u.test(section) ? `${label} ${section}` : section;
}

function entry(
  source: WebPageSource,
  heading: string,
  notes: string,
  release: { readonly version: string | null; readonly publishedAt: number | null },
  marker?: string,
): ChangelogEntry {
  return {
    key: `web:${source.page_url}${marker === undefined ? "" : `#${marker}`}`,
    origin: "changelog_file",
    title: heading,
    notes,
    url: source.page_url,
    version: release.version,
    prerelease: false,
    publishedAt: release.publishedAt,
    historical: false,
  };
}

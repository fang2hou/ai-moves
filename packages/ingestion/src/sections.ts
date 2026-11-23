// Splitting a published changelog into releases. A documentation changelog carries
// every version of a product on one page, and reading it as a single document buries
// what changed in the newest release under months of history.

export interface ChangelogSection {
  // Identifies the release inside the page, and is what the source cursor stores.
  readonly marker: string;
  // Reads as a title on its own: a bare version number is qualified by the surface
  // it belongs to when the page names one.
  readonly label: string;
  // The product surface the release belongs to, when the page groups its releases
  // under one. A suite publishes an app, a CLI and an SDK on the same page.
  readonly surface: string | null;
  readonly version: string | null;
  readonly publishedAt: number | null;
  readonly notes: string;
}

// A heading or a bold line on its own, which is how the sites in the watchlist mark a
// release in Markdown.
const MARKER_LINE = /^(?:(#{1,6})[ \t]+(.+?)|\*\*(.+?)\*\*)[ \t]*$/gmu;
const VERSION = /^\[?v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\]?(?=[\s([\]]|$)/u;
// A page rendered to plain text keeps no headings, so a dated product line is the only
// boundary left: `2026-11-20 Codex CLI 0.171.0`.
const DATED = /(\d{4}-\d{2}-\d{2})[ \t]+([A-Z][\w .&+-]*?[ \t]\d+\.\d+(?:\.\d+)?)/gu;

// A heading may link to the release it names; only its text belongs in a title.
function plainTitle(title: string): string {
  return title
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*`]/gu, "")
    .trim();
}

interface Marker {
  readonly marker: string;
  readonly label: string;
  readonly surface: string | null;
  readonly version: string | null;
  readonly publishedAt: number | null;
  readonly start: number;
}

function markdownMarkers(text: string): readonly Marker[] {
  const markers: Marker[] = [];
  let surface: string | null = null;
  for (const match of text.matchAll(MARKER_LINE)) {
    const title = plainTitle(match[2] ?? match[3] ?? "");
    const depth = match[1]?.length ?? 7;
    const version = VERSION.exec(title)?.[1];
    if (version === undefined) {
      // A second-level heading groups the versions under it, such as one product
      // surface of a suite. Deeper headings are sections inside a release.
      if (depth === 2) surface = title;
      continue;
    }
    const qualified = surface === null ? title : `${surface} ${title}`;
    markers.push({
      marker: qualified,
      label: qualified,
      surface,
      version,
      publishedAt: null,
      start: match.index,
    });
  }
  return markers;
}

function datedMarkers(text: string): readonly Marker[] {
  const markers: Marker[] = [];
  for (const match of text.matchAll(DATED)) {
    const date = match[1] ?? "";
    const label = (match[2] ?? "").trim();
    const at = Date.parse(`${date}T00:00:00Z`);
    markers.push({
      marker: match[0],
      label,
      surface: null,
      version: /(\d+\.\d+(?:\.\d+)?)$/u.exec(label)?.[1] ?? null,
      publishedAt: Number.isFinite(at) ? at : null,
      start: match.index,
    });
  }
  return markers;
}

// Ordered as the page orders them, which on every watched changelog is newest first.
export function splitChangelog(text: string): readonly ChangelogSection[] {
  const found = markdownMarkers(text);
  const markers = found.length > 1 ? found : datedMarkers(text);
  return markers.map((marker, index) => ({
    marker: marker.marker,
    label: marker.label,
    surface: marker.surface,
    version: marker.version,
    publishedAt: marker.publishedAt,
    notes: text.slice(marker.start, markers[index + 1]?.start).trim(),
  }));
}

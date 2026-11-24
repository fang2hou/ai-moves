import type { ChangelogSection } from "./section.ts";

// HTML extraction flattens the changelog's headings and body into one line.
const DATED_RELEASE = /(\d{4}-\d{2}-\d{2})[ \t]+([A-Z][\w .&+-]*?[ \t]\d+\.\d+(?:\.\d+)?)/gu;

export function parseDatedChangelog(text: string): readonly ChangelogSection[] {
  const releases = Array.from(text.matchAll(DATED_RELEASE));
  return releases.map((match, index) => {
    const label = (match[2] ?? "").trim();
    const publishedAt = Date.parse(`${match[1]}T00:00:00Z`);
    return {
      marker: match[0],
      label,
      surface: null,
      version: /(\d+\.\d+(?:\.\d+)?)$/u.exec(label)?.[1] ?? null,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      notes: text.slice(match.index, releases[index + 1]?.index).trim(),
    };
  });
}

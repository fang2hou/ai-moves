import type { ChangelogSection } from "./section.ts";

const VERSION = /^\[?v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\]?(?=[\s([\]]|$)/u;

interface Release {
  readonly start: number;
  readonly fields: Omit<ChangelogSection, "notes">;
}

export function parseMarkdownSections(
  text: string,
  headingOrBold: RegExp,
): readonly ChangelogSection[] {
  const releases: Release[] = [];
  let surface: string | null = null;
  for (const match of text.matchAll(headingOrBold)) {
    const title = plainTitle(match[2] ?? match[3] ?? "");
    const version = VERSION.exec(title)?.[1];
    if (version === undefined) {
      if (match[1] === "##") surface = title;
      continue;
    }
    const label = surface === null ? title : `${surface} ${title}`;
    releases.push({
      start: match.index,
      fields: { marker: label, label, surface, version, publishedAt: null },
    });
  }
  return releases.map(({ start, fields }, index) => ({
    ...fields,
    notes: text.slice(start, releases[index + 1]?.start).trim(),
  }));
}

function plainTitle(title: string): string {
  return title
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*`]/gu, "")
    .trim();
}

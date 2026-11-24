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
    const { title, version } = readMarkdownTitle(match[2] ?? match[3] ?? "");
    if (version === null) {
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

export function readMarkdownTitle(markdown: string): { title: string; version: string | null } {
  const title = markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*`]/gu, "")
    .trim();
  return { title, version: VERSION.exec(title)?.[1] ?? null };
}

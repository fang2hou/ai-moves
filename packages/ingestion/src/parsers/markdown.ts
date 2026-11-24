import type { ChangelogSection } from "./section.ts";

const VERSION = /^\[?v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\]?(?=[\s([\]]|$)/u;

interface Boundary {
  readonly start: number;
  readonly release: Omit<ChangelogSection, "notes"> | null;
}

export function parseMarkdownSections(
  text: string,
  headingOrBold: RegExp,
): readonly ChangelogSection[] {
  const boundaries: Boundary[] = [];
  let surface: string | null = null;
  for (const match of text.matchAll(headingOrBold)) {
    const title = plainTitle(match[2] ?? match[3] ?? "");
    const version = VERSION.exec(title)?.[1];
    if (version === undefined) {
      if (match[1] === "##") {
        surface = title;
        boundaries.push({ start: match.index, release: null });
      }
      continue;
    }
    const label = surface === null ? title : `${surface} ${title}`;
    boundaries.push({
      start: match.index,
      release: { marker: label, label, surface, version, publishedAt: null },
    });
  }
  return boundaries.flatMap(({ start, release }, index) =>
    release === null
      ? []
      : [{ ...release, notes: text.slice(start, boundaries[index + 1]?.start).trim() }],
  );
}

function plainTitle(title: string): string {
  return title
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*`]/gu, "")
    .trim();
}

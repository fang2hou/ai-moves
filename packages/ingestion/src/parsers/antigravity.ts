import { parseMarkdownSections, readMarkdownTitle } from "./markdown.ts";
import type { ChangelogSection } from "./section.ts";

const SURFACE_HEADING = /^##[ \t]+.+$/gmu;
const SURFACE_OR_RELEASE_LINE = /^(?:(#{2,6})[ \t]+(.+?)|\*\*(.+?)\*\*)[ \t]*$/gmu;

export function parseAntigravity(text: string): readonly ChangelogSection[] {
  const boundaries = [0];
  for (const heading of text.matchAll(SURFACE_HEADING)) {
    if (readMarkdownTitle(heading[0].slice(2)).version === null) boundaries.push(heading.index);
  }
  return boundaries.flatMap((start, index) =>
    parseMarkdownSections(text.slice(start, boundaries[index + 1]), SURFACE_OR_RELEASE_LINE),
  );
}

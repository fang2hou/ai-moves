import { parseMarkdownSections } from "./markdown.ts";
import type { ChangelogSection } from "./section.ts";

const SURFACE_HEADING = /^##[ \t]+.+$/gmu;
const SURFACE_OR_RELEASE_LINE = /^(?:(#{2,3})[ \t]+(.+?)|\*\*(.+?)\*\*)[ \t]*$/gmu;

export function parseAntigravity(text: string): readonly ChangelogSection[] {
  const surfaces = Array.from(text.matchAll(SURFACE_HEADING));
  return surfaces.flatMap((heading, index) =>
    parseMarkdownSections(
      text.slice(heading.index, surfaces[index + 1]?.index),
      SURFACE_OR_RELEASE_LINE,
    ),
  );
}

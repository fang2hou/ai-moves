import { parseMarkdownSections } from "./markdown.ts";
import type { ChangelogSection } from "./section.ts";

const SURFACE_OR_RELEASE_LINE = /^(?:(#{2,3})[ \t]+(.+?)|\*\*(.+?)\*\*)[ \t]*$/gmu;

export function parseAntigravity(text: string): readonly ChangelogSection[] {
  return parseMarkdownSections(text, SURFACE_OR_RELEASE_LINE);
}

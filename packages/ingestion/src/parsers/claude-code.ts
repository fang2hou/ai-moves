import { parseMarkdownSections } from "./markdown.ts";
import type { ChangelogSection } from "./section.ts";

const RELEASE_LINE = /^(?:(##)[ \t]+(.+?)|\*\*(.+?)\*\*)[ \t]*$/gmu;

export function parseClaudeCode(text: string): readonly ChangelogSection[] {
  return parseMarkdownSections(text, RELEASE_LINE);
}

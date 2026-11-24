import { parseMarkdownSections } from "./markdown.ts";
import { parseDatedChangelog } from "./openai-chatgpt.ts";
import type { ChangelogSection } from "./section.ts";

const HEADING_OR_BOLD = /^(?:(#{1,6})[ \t]+(.+?)|\*\*(.+?)\*\*)[ \t]*$/gmu;

export function parseGenericChangelog(text: string): readonly ChangelogSection[] {
  const markdown = parseMarkdownSections(text, HEADING_OR_BOLD);
  if (markdown.length > 1) return markdown;
  const dated = parseDatedChangelog(text);
  return dated.length > 0 ? dated : markdown;
}

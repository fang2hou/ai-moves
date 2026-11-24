import { parseAntigravity } from "./antigravity.ts";
import { parseClaudeCode } from "./claude-code.ts";
import { parseGenericChangelog } from "./generic.ts";
import { parseDatedChangelog } from "./openai-chatgpt.ts";
import type { ChangelogSection } from "./section.ts";

const PARSERS = new Map<string, (text: string) => readonly ChangelogSection[]>([
  ["code.claude.com", parseClaudeCode],
  ["learn.chatgpt.com", parseDatedChangelog],
  ["antigravity.google", parseAntigravity],
]);

export function parseChangelog(pageUrl: string, text: string): readonly ChangelogSection[] {
  const hostname = new URL(pageUrl).hostname.replace(/^www\./u, "");
  const sections = PARSERS.get(hostname)?.(text);
  return sections?.length ? sections : parseGenericChangelog(text);
}

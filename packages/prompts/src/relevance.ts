import type { HnRelevanceStory } from "@ai-news-tracker/contracts/ports/llm";
import type { TraceId } from "@ai-news-tracker/contracts/primitives";
import { HnRelevanceSchema } from "@ai-news-tracker/contracts/scoring";
import { z } from "zod";

import { renderPrompt, type RenderedPrompt } from "./render.ts";
import { HN_RELEVANCE_PROMPT_VERSION } from "./versions.ts";

export const HnRelevanceOutputSchema = z.strictObject({
  stories: z.array(z.strictObject({ id: z.string(), relevance: HnRelevanceSchema })),
});

export interface HnRelevancePromptInput {
  readonly traceId: TraceId;
  readonly topics: readonly string[];
  readonly products: readonly string[];
  readonly stories: readonly HnRelevanceStory[];
}

// Runs on the triage route: the call is a cheap screen over titles, not an analysis.
export function renderHnRelevancePrompt({
  traceId,
  topics,
  products,
  stories,
}: HnRelevancePromptInput): RenderedPrompt<z.infer<typeof HnRelevanceOutputSchema>> {
  return {
    ...renderPrompt(
      "triage",
      HnRelevanceOutputSchema,
      traceId,
      [
        "You pick stories for engineers at a financial company who adopt new technology eagerly and use AI in their daily development. Classify each Hacker News story by how useful it is to them, judging only its title and link.",
        "core: AI itself. Any mainstream AI model or model family and anything that happens to it, such as releases, pricing, usage limits, outages, benchmarks, and policy changes (examples: GPT, Claude, Gemini, Llama, Grok, Mistral, DeepSeek, Qwen, Kimi, GLM, MiniMax); any mainstream agent harness or AI coding tool and how engineers work with it (examples: Codex, Claude Code, Gemini CLI, Antigravity, Cursor, GitHub Copilot, Windsurf, Cline, Aider, OpenCode, Pi, oh-my-pi, Amp, Kiro, Devin); using AI to raise productivity or in real company work; and how AI is changing engineers' work, teams, companies, and society, including research and analysis of its effect on productivity, jobs, and how organizations work. The supplied products are core too; the supplied topics are context only.",
        "adjacent: engineering that is not about AI but that these engineers would still want to know. Software engineering and developer tooling, including notable new features of the tools they use every day; AI research outside the core topics above, and niche models; security incidents with engineering substance or wide consequences, such as a major vulnerability or an incident that caused broad harm; and industry, market, or regulatory shifts that change how software is built or bought.",
        "unrelated: stories with nothing for an engineer to act on or learn from. Personal or gossip angles on people and companies are unrelated even when the company is technical, unless the story is about the technical or market consequences. So are science, health, politics, and culture without an engineering angle.",
        "When a title is ambiguous between core and adjacent, choose adjacent; between adjacent and unrelated, choose adjacent when an engineer could plausibly learn something technical from it.",
        "Return one entry per supplied story with its id copied exactly.",
      ],
      { topics, products, stories },
    ),
    promptVersion: HN_RELEVANCE_PROMPT_VERSION,
    schemaName: HN_RELEVANCE_PROMPT_VERSION,
  };
}

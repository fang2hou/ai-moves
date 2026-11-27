import type { HnRelevanceStory } from "@ai-moves/contracts/ports/llm";
import type { TraceId } from "@ai-moves/contracts/primitives";
import { HnRelevanceSchema } from "@ai-moves/contracts/scoring";
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
        "Classify each Hacker News story by how close it is to the desk's focus, judging only its title and link. The focus: AI development and model releases; using AI models; using AI to raise productivity; AI in real company work and operations; and accelerating software development with AI, such as coding agents, agent harnesses, and AI coding tools.",
        "core: the focus itself. Any mainstream AI model or model family and anything that happens to it, such as releases, pricing, usage limits, outages, benchmarks, and policy changes. Examples: GPT, Claude, Gemini, Llama, Grok, Mistral, DeepSeek, Qwen, Kimi, GLM, MiniMax.",
        "core also covers any mainstream agent harness or AI coding tool and how engineers work with it, and stories about using AI to raise productivity or about AI in company work. Examples: Codex, Claude Code, Gemini CLI, Antigravity, Cursor, GitHub Copilot, Windsurf, Cline, Aider, OpenCode, Pi, oh-my-pi, Amp, Kiro, Devin. The supplied products are core too; the supplied topics are context only.",
        "adjacent: other AI or machine learning that is not the focus, such as research, smaller or niche models, and AI companies or policy without a mainstream model or tool. These stay adjacent even when they match a supplied topic.",
        "unrelated: no AI focus. This includes general software engineering, developer tooling, security incidents, lawsuits, and business news even when the story is technical, and science, health, politics, or culture. A story is unrelated unless it is about AI itself: a company's breach, indictment, funding, or outage is unrelated when AI is not what the story is about.",
        "When a title is ambiguous between core and adjacent, choose adjacent. When AI is not evident in the title or link, choose unrelated.",
        "Return one entry per supplied story with its id copied exactly.",
      ],
      { topics, products, stories },
    ),
    promptVersion: HN_RELEVANCE_PROMPT_VERSION,
    schemaName: HN_RELEVANCE_PROMPT_VERSION,
  };
}

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
        "Classify each Hacker News story by how close it is to AI-assisted software engineering, judging only its title and link.",
        "core: any mainstream AI model or model family and anything that happens to it, such as releases, pricing, usage limits, outages, benchmarks, and policy changes. Examples: GPT, Claude, Gemini, Llama, Grok, Mistral, DeepSeek, Qwen, Kimi, GLM, MiniMax.",
        "core also covers any mainstream agent harness or AI coding tool and how engineers work with it. Examples: Codex, Claude Code, Gemini CLI, Antigravity, Cursor, GitHub Copilot, Windsurf, Cline, Aider, OpenCode, Pi, oh-my-pi, Amp, Kiro, Devin. The supplied products and topics are core too.",
        "adjacent: other AI or machine learning, such as research, smaller or niche models, and AI companies or policy without a mainstream model or tool, and software engineering or developer tooling without an AI angle.",
        "unrelated: anything else, such as science, health, politics, business, or culture with no AI or software engineering angle.",
        "When a title is ambiguous, choose adjacent.",
        "Return one entry per supplied story with its id copied exactly.",
      ],
      { topics, products, stories },
    ),
    promptVersion: HN_RELEVANCE_PROMPT_VERSION,
    schemaName: HN_RELEVANCE_PROMPT_VERSION,
  };
}

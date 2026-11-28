import type { LlmClient } from "@ai-news-tracker/contracts/ports/llm";

import { createOpenAiCompatibleClient, type OpenAiCompatibleOptions } from "./openai-compatible.ts";

export type OpenRouterOptions = OpenAiCompatibleOptions;

export function createOpenRouterClient(options: OpenRouterOptions): Promise<LlmClient> {
  return createOpenAiCompatibleClient(
    options,
    "https://openrouter.ai/api/v1/chat/completions",
    () => ({
      provider: { require_parameters: true, allow_fallbacks: false },
    }),
  );
}

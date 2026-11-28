import type { LlmClient } from "@ai-news-tracker/contracts/ports/llm";

import { createOpenAiCompatibleClient, type OpenAiCompatibleOptions } from "./openai-compatible.ts";

export interface HyperOptions extends OpenAiCompatibleOptions {
  readonly endpoint?: string;
}

export function createHyperClient(options: HyperOptions): Promise<LlmClient> {
  return createOpenAiCompatibleClient(
    options,
    options.endpoint ?? "https://hyper.charm.land/v1/chat/completions",
    (route) => (route.effort === undefined ? {} : { reasoning_effort: route.effort }),
  );
}

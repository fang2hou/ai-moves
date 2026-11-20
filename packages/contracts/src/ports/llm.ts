import type { z } from "zod";

import type { LlmUsage } from "../entities.ts";
import type { TraceId } from "../primitives.ts";
import type { AnalysisStage } from "../states.ts";

export interface LlmMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface GenerateStructuredRequest<Output> {
  // Logical model name; configuration maps it to a provider model id.
  readonly stage: AnalysisStage;
  readonly schemaName: string;
  readonly schema: z.ZodType<Output>;
  readonly messages: readonly LlmMessage[];
  readonly traceId: TraceId;
}

export interface GenerateStructuredResult<Output> {
  readonly output: Output;
  readonly model: string;
  readonly usage: LlmUsage;
  readonly repaired: boolean;
  readonly usedFallback: boolean;
}

// The model has no tools and no network access. Implementations validate the response against
// `schema` locally whatever the provider enforces, retry one repair, then one fallback model
// (architecture 4.5), and reject with LLM_OUTPUT_INVALID, BUDGET_EXHAUSTED, or an UPSTREAM_* code.
export interface LlmClient {
  generateStructured<Output>(
    request: GenerateStructuredRequest<Output>,
  ): Promise<GenerateStructuredResult<Output>>;
}

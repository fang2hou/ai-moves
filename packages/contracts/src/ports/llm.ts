import type { z } from "zod";

import type { LlmUsage } from "../entities.ts";
import type { TraceId } from "../primitives.ts";
import type { HnRelevance } from "../scoring.ts";
import type { AnalysisStage } from "../states.ts";

export interface HnRelevanceStory {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
}

export interface HnRelevanceJudge {
  // The prompt version behind every verdict. A verdict stored under another version is asked
  // again, so a stricter prompt applies to stories still being tracked.
  readonly version: string;
  // Judges a batch of stories in one model call, keyed by story id, giving up after `timeoutMs`.
  // A story missing from the result stays unjudged; it never throws for a model failure.
  judge(
    stories: readonly HnRelevanceStory[],
    timeoutMs: number,
  ): Promise<ReadonlyMap<string, HnRelevance>>;
}

export interface LlmMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface GenerateStructuredRequest<Output> {
  readonly stage: AnalysisStage;
  readonly schemaName: string;
  // Callers supply a strict model-facing schema from prompts; the adapter remains schema-agnostic.
  readonly schema: z.ZodType<Output>;
  readonly messages: readonly LlmMessage[];
  readonly traceId: TraceId;
  // Receives usage once per attempt when reported, even if the attempt fails validation.
  readonly onUsage?: (reported: Readonly<LlmUsage>) => void;
}

export interface GenerateStructuredResult<Output> {
  readonly output: Output;
  readonly model: string;
  readonly usage: LlmUsage;
  readonly repaired: boolean;
  readonly usedFallback: boolean;
}

// The model has no tools or network access. Adapters return locally validated output, even when the
// provider also enforces `schema`, and never persist provider payloads. Try one repair, then one
// fallback model; provider failures use LLM_OUTPUT_INVALID or an UPSTREAM_* code.
export interface LlmClient {
  generateStructured<Output>(
    request: GenerateStructuredRequest<Output>,
  ): Promise<GenerateStructuredResult<Output>>;
}

import type {
  GenerateStructuredRequest,
  GenerateStructuredResult,
  LlmClient,
} from "@ai-moves/contracts/ports/llm";
import { parseBoundary } from "@ai-moves/kernel/boundary";

import { type ScriptStep, scriptedMethod } from "./script.ts";

export interface ScriptedLlmClient extends LlmClient {
  readonly calls: readonly [GenerateStructuredRequest<unknown>][];
}

export function createScriptedLlmClient(
  steps: readonly ScriptStep<GenerateStructuredResult<unknown>>[],
): ScriptedLlmClient {
  const generation = scriptedMethod<
    [GenerateStructuredRequest<unknown>],
    GenerateStructuredResult<unknown>
  >("LlmClient.generateStructured", steps);
  return {
    calls: generation.calls,
    generateStructured: async <Output>(
      request: GenerateStructuredRequest<Output>,
    ): Promise<GenerateStructuredResult<Output>> => {
      const result = await generation.run(request);
      const output = parseBoundary(request.schema, result.output, "LLM_OUTPUT_INVALID");
      return { ...result, output };
    },
  };
}

import type { ModelConfig } from "@ai-moves/contracts/config";
import type { LlmUsage } from "@ai-moves/contracts/entities";
import {
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type LlmClient,
  type LlmMessage,
} from "@ai-moves/contracts/ports/llm";
import type { HttpFetch, SecretProvider } from "@ai-moves/contracts/ports/runtime";
import type { SecretRef } from "@ai-moves/contracts/primitives";
import type { AnalysisStage } from "@ai-moves/contracts/states";
import { AppError, isAppError } from "@ai-moves/kernel/errors/app-error";
import { withTimeout } from "@ai-moves/kernel/timeout";
import { z } from "zod";

import { decodeCompletion, responseError } from "./protocol.ts";

const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const maxCompletionBytes = 256 * 1024;

const repairInstruction: LlmMessage = {
  role: "user",
  content:
    "The previous completion did not match the response schema. Regenerate from the original input, following the schema exactly. Return only the JSON object.",
};

export interface OpenRouterOptions {
  readonly fetch: HttpFetch;
  readonly secrets: SecretProvider;
  readonly secretRef: SecretRef;
  readonly models: Readonly<Record<AnalysisStage, Readonly<Omit<ModelConfig, "provider">>>>;
  readonly timeoutMs: number;
}

function canFallback(error: unknown): boolean {
  return (
    isAppError(error) &&
    error.retryAfterMs === undefined &&
    (error.kind === "retryable" ||
      error.code === "LLM_OUTPUT_INVALID" ||
      error.code === "UPSTREAM_RESPONSE_INVALID")
  );
}

export async function createOpenRouterClient(options: OpenRouterOptions): Promise<LlmClient> {
  const key = await options.secrets.get(options.secretRef);
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  return {
    async generateStructured<Output>(
      request: GenerateStructuredRequest<Output>,
    ): Promise<GenerateStructuredResult<Output>> {
      const route = options.models[request.stage];
      const schema = z.toJSONSchema(request.schema, { io: "input" });
      delete schema.$schema;
      const format = {
        type: "json_schema",
        json_schema: { name: request.schemaName, strict: true, schema },
      };
      const usage: LlmUsage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
      const accountUsage = (reported: LlmUsage): void => {
        usage.input_tokens += reported.input_tokens;
        usage.output_tokens += reported.output_tokens;
        usage.cost_usd =
          usage.cost_usd === null || reported.cost_usd === null
            ? null
            : usage.cost_usd + reported.cost_usd;
      };

      const attempt = async (
        model: string,
        repaired: boolean,
        usedFallback: boolean,
      ): Promise<GenerateStructuredResult<Output>> => {
        const completion = await withTimeout(
          async (signal) => {
            const outgoing = new Request(endpoint, {
              method: "POST",
              headers,
              redirect: "manual",
              signal,
              body: JSON.stringify({
                model,
                messages: repaired ? [...request.messages, repairInstruction] : request.messages,
                stream: false,
                max_tokens: route.max_output_tokens,
                response_format: format,
                provider: { require_parameters: true, allow_fallbacks: false },
              }),
            });
            let response: Response;
            try {
              response = await options.fetch(outgoing);
            } catch {
              signal.throwIfAborted();
              throw new AppError("UPSTREAM_UNAVAILABLE");
            }
            const retryAfter = response.headers.get("retry-after");
            if (!response.ok || signal.aborted) {
              // A late response or slow cancellation cannot change the classified outcome.
              void response.body?.cancel().catch(() => undefined);
              signal.throwIfAborted();
              throw responseError(response.status, retryAfter);
            }
            const body = await readCompletion(response, signal);
            return decodeCompletion(body, retryAfter, request.schema, accountUsage);
          },
          { timeoutMs: options.timeoutMs },
        );
        return { ...completion, usage, repaired, usedFallback };
      };

      try {
        try {
          return await attempt(route.model, false, false);
        } catch (error) {
          if (!isAppError(error) || error.code !== "LLM_OUTPUT_INVALID") throw error;
          return await attempt(route.model, true, false);
        }
      } catch (error) {
        const fallback = route.fallbacks[0];
        if (fallback === undefined || fallback === route.model || !canFallback(error)) throw error;
        return attempt(fallback, false, true);
      }
    },
  };
}

async function readCompletion(response: Response, signal: AbortSignal): Promise<string> {
  const body = response.body;
  if (response.bodyUsed || body?.locked === true) throw new AppError("UPSTREAM_UNAVAILABLE");
  const reader = body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let remaining = maxCompletionBytes;
  let text = "";
  let finished = false;
  const cancel = (): void => {
    // The attempt deadline must not wait for the underlying stream to acknowledge cancellation.
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        signal.throwIfAborted();
        throw new AppError("UPSTREAM_UNAVAILABLE");
      }
      signal.throwIfAborted();
      if (chunk.done) {
        finished = true;
        return text + decoder.decode();
      }
      remaining -= chunk.value.byteLength;
      if (remaining < 0) throw new AppError("UPSTREAM_RESPONSE_INVALID");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished && !signal.aborted) cancel();
    reader.releaseLock();
  }
}

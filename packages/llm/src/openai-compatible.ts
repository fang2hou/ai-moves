import type { ModelConfig } from "@ai-news-tracker/contracts/config";
import type { LlmUsage } from "@ai-news-tracker/contracts/entities";
import {
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type LlmClient,
  type LlmMessage,
} from "@ai-news-tracker/contracts/ports/llm";
import type { HttpFetch, SecretProvider } from "@ai-news-tracker/contracts/ports/runtime";
import type { SecretRef } from "@ai-news-tracker/contracts/primitives";
import type { AnalysisStage } from "@ai-news-tracker/contracts/states";
import { AppError, isAppError } from "@ai-news-tracker/kernel/errors/app-error";
import { withTimeout } from "@ai-news-tracker/kernel/timeout";
import { z } from "zod";

import { decodeCompletion, readCompletion, responseError } from "./protocol.ts";

const repairInstruction: LlmMessage = {
  role: "user",
  content:
    "The previous completion did not match the response schema. Regenerate from the original input, following the schema exactly. Return only the JSON object.",
};

type ModelRoute = Readonly<
  Pick<ModelConfig, "model" | "fallbacks" | "max_output_tokens" | "effort">
>;

export interface OpenAiCompatibleOptions {
  readonly fetch: HttpFetch;
  readonly secrets: SecretProvider;
  readonly secretRef: SecretRef;
  readonly models: Readonly<Record<AnalysisStage, ModelRoute>>;
  readonly timeoutMs: number;
}

function canFallback(error: unknown): boolean {
  if (!isAppError(error)) return false;
  // A throttled route is the one case worth taking the other route for immediately:
  // waiting out the delay stalls the stage, and a free endpoint is throttled often.
  if (error.code === "UPSTREAM_RATE_LIMITED") return true;
  return (
    error.retryAfterMs === undefined &&
    (error.kind === "retryable" ||
      error.code === "LLM_OUTPUT_INVALID" ||
      error.code === "UPSTREAM_RESPONSE_INVALID")
  );
}

export async function createOpenAiCompatibleClient(
  options: OpenAiCompatibleOptions,
  endpoint: string,
  requestParameters: (route: ModelRoute) => Record<string, unknown>,
): Promise<LlmClient> {
  const key = await options.secrets.get(options.secretRef);
  const headers = new Headers({ "content-type": "application/json" });
  try {
    headers.set("authorization", `Bearer ${key}`);
  } catch {
    throw new AppError("CONFIG_INVALID", { message: "Invalid provider credential format" });
  }
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
        request.onUsage?.(reported);
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
                ...requestParameters(route),
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
        // Every configured fallback is tried in turn: the first route is the cheap
        // one and is often throttled, so one alternative is rarely enough.
        let failure = error;
        for (const fallback of route.fallbacks) {
          if (fallback === route.model || !canFallback(failure)) break;
          try {
            return await attempt(fallback, false, true);
          } catch (next) {
            failure = next;
          }
        }
        throw failure;
      }
    },
  };
}

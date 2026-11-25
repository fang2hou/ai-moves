import type { ModelConfig } from "@ai-moves/contracts/config";
import type { LlmUsage } from "@ai-moves/contracts/entities";
import type {
  GenerateStructuredRequest,
  GenerateStructuredResult,
  LlmClient,
  LlmMessage,
} from "@ai-moves/contracts/ports/llm";
import type { HttpFetch } from "@ai-moves/contracts/ports/runtime";
import type { AnalysisStage } from "@ai-moves/contracts/states";
import { AppError, isAppError } from "@ai-moves/kernel/errors/app-error";
import { withTimeout } from "@ai-moves/kernel/timeout";
import { z } from "zod";

import { claudeJsonSchema } from "./claude-schema.ts";
import { readCompletion, responseError } from "./protocol.ts";

const API_VERSION = "2026-10-21";
const INVOKE_ANTHROPIC_VERSION = "bedrock-2023-05-31";

const repairInstruction: LlmMessage = {
  role: "user",
  content:
    "The previous completion did not match the response schema. Regenerate from the original input, following the schema exactly. Return only the JSON object.",
};

// `messages`: the Messages API on the `bedrock-mantle` endpoint, signed for `bedrock-mantle`.
// `invoke`: InvokeModel on `bedrock-runtime`, signed for `bedrock`, where routes name a model or
// an inference profile such as `global.anthropic.claude-sonnet-5`.
export type BedrockTransport = "messages" | "invoke";

export interface BedrockClaudeOptions {
  readonly transport: BedrockTransport;
  // Signs each request for the transport's service; the adapter itself holds no credential.
  readonly fetch: HttpFetch;
  readonly region: string;
  readonly models: Readonly<Record<AnalysisStage, Readonly<Omit<ModelConfig, "provider">>>>;
  readonly timeoutMs: number;
  // Overrides the regional endpoint origin, for example a local stand-in.
  readonly endpoint?: string | undefined;
}

const MessageSchema = z.object({
  model: z.string().min(1).max(128).optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullable(),
  stop_details: z.object({ category: z.string().nullable().optional() }).nullable().optional(),
  usage: z.object({
    input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative(),
    cache_creation_input_tokens: z.int().nonnegative().nullish(),
    cache_read_input_tokens: z.int().nonnegative().nullish(),
  }),
});

// A safety decline is permanent for that model but says nothing about another one, so it is the
// one rejection that still tries the fallback routes.
function isRefusal(error: unknown): boolean {
  return (
    isAppError(error) &&
    error.code === "UPSTREAM_REJECTED" &&
    error.context?.["reason"] === "refusal"
  );
}

// Bedrock answers 400, 403, or 404 for a model the account has not enabled or the region does not
// serve, so another route may still work.
function isUnavailableModel(error: unknown): boolean {
  const status = isAppError(error) ? error.context?.["status"] : undefined;
  return (
    isAppError(error) &&
    error.code === "UPSTREAM_REJECTED" &&
    (status === 400 || status === 403 || status === 404)
  );
}

function canFallback(error: unknown): boolean {
  if (!isAppError(error)) return false;
  if (error.code === "UPSTREAM_RATE_LIMITED" || isRefusal(error) || isUnavailableModel(error)) {
    return true;
  }
  return (
    error.retryAfterMs === undefined &&
    (error.kind === "retryable" ||
      error.code === "LLM_OUTPUT_INVALID" ||
      error.code === "UPSTREAM_RESPONSE_INVALID")
  );
}

function decodeMessage<Output>(
  body: string,
  requested: string,
  schema: z.ZodType<Output>,
  accountUsage: (usage: LlmUsage) => void,
): { output: Output; model: string } {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new AppError("UPSTREAM_RESPONSE_INVALID");
  }
  const message = MessageSchema.safeParse(value);
  if (!message.success) throw new AppError("UPSTREAM_RESPONSE_INVALID");
  const { usage, stop_reason: stopReason } = message.data;
  accountUsage({
    input_tokens:
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    output_tokens: usage.output_tokens,
    cost_usd: null,
  });
  if (stopReason === "refusal") {
    throw new AppError("UPSTREAM_REJECTED", {
      context: { reason: "refusal", category: message.data.stop_details?.category ?? null },
    });
  }
  // Thinking blocks come first and are empty by default; the answer is the text block.
  const text = message.data.content.find((block) => block.type === "text")?.text;
  if (stopReason !== "end_turn" || text === undefined) throw new AppError("LLM_OUTPUT_INVALID");
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    throw new AppError("LLM_OUTPUT_INVALID");
  }
  const validated = schema.safeParse(output);
  if (!validated.success) throw new AppError("LLM_OUTPUT_INVALID");
  return { output: validated.data, model: message.data.model ?? requested };
}

interface Endpoint {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
}

function endpointFor(options: BedrockClaudeOptions, model: string): Endpoint {
  if (options.transport === "invoke") {
    const origin = options.endpoint ?? `https://bedrock-runtime.${options.region}.amazonaws.com`;
    return {
      url: new URL(`/model/${encodeURIComponent(model)}/invoke`, origin),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: { anthropic_version: INVOKE_ANTHROPIC_VERSION },
    };
  }
  const origin = options.endpoint ?? `https://bedrock-mantle.${options.region}.api.aws`;
  return {
    url: new URL("/anthropic/v1/messages", origin),
    headers: { "content-type": "application/json", "anthropic-version": API_VERSION },
    body: { model },
  };
}

// Claude on Amazon Bedrock with structured output and the route's effort, through either
// transport. Thinking stays at the model default, and no sampling parameters are sent, since
// current models reject them.
export function createBedrockClaudeClient(options: BedrockClaudeOptions): LlmClient {
  return {
    async generateStructured<Output>(
      request: GenerateStructuredRequest<Output>,
    ): Promise<GenerateStructuredResult<Output>> {
      const route = options.models[request.stage];
      const format = { type: "json_schema", schema: claudeJsonSchema(request.schema) };
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const conversation = request.messages
        .filter((message) => message.role === "user")
        .map((message) => ({ role: "user", content: message.content }));
      const usage: LlmUsage = { input_tokens: 0, output_tokens: 0, cost_usd: null };
      const accountUsage = (reported: LlmUsage): void => {
        usage.input_tokens += reported.input_tokens;
        usage.output_tokens += reported.output_tokens;
      };

      const attempt = async (
        model: string,
        repaired: boolean,
        usedFallback: boolean,
      ): Promise<GenerateStructuredResult<Output>> => {
        const completion = await withTimeout(
          async (signal) => {
            const endpoint = endpointFor(options, model);
            const outgoing = new Request(endpoint.url, {
              method: "POST",
              headers: endpoint.headers,
              redirect: "manual",
              signal,
              body: JSON.stringify({
                ...endpoint.body,
                max_tokens: route.max_output_tokens,
                ...(system === "" ? {} : { system }),
                messages: repaired ? [...conversation, repairInstruction] : conversation,
                output_config: {
                  ...(route.effort === undefined ? {} : { effort: route.effort }),
                  format,
                },
              }),
            });
            let response: Response;
            try {
              response = await options.fetch(outgoing);
            } catch {
              signal.throwIfAborted();
              throw new AppError("UPSTREAM_UNAVAILABLE");
            }
            if (!response.ok || signal.aborted) {
              void response.body?.cancel().catch(() => undefined);
              signal.throwIfAborted();
              throw responseError(response.status, response.headers.get("retry-after"));
            }
            const body = await readCompletion(response, signal);
            return decodeMessage(body, model, request.schema, accountUsage);
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

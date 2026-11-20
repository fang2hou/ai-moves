import type { LlmUsage } from "@ai-moves/contracts/entities";
import type { ErrorCode } from "@ai-moves/contracts/errors";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { z } from "zod";

const ProviderErrorSchema = z.object({ code: z.int() });
const UsageSchema = z.object({
  prompt_tokens: z.int().nonnegative(),
  completion_tokens: z.int().nonnegative(),
  cost: z.number().nonnegative().nullish(),
});
const EnvelopeSchema = z.object({
  model: z.unknown().optional(),
  choices: z.array(z.unknown()).optional(),
  usage: z.unknown().optional(),
  error: z.unknown().optional(),
});
const ChoiceSchema = z.object({
  finish_reason: z.string().nullable(),
  message: z.unknown().optional(),
  error: z.unknown().optional(),
});
const MessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string().nullable(),
});
const ModelSchema = z.string().min(1).max(128);

function statusCode(status: number, retryAfterMs: number | undefined): ErrorCode {
  if (status === 402) {
    return retryAfterMs === undefined ? "BUDGET_EXHAUSTED" : "UPSTREAM_RATE_LIMITED";
  }
  if (status === 408 || status === 504) return "UPSTREAM_TIMEOUT";
  if (status === 429) return "UPSTREAM_RATE_LIMITED";
  if (status >= 500 && status <= 599) return "UPSTREAM_UNAVAILABLE";
  if (status >= 300 && status <= 499) return "UPSTREAM_REJECTED";
  return "UPSTREAM_RESPONSE_INVALID";
}

export function responseError(status: number, retryAfter: string | null): AppError {
  const delay = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : NaN;
  const retryAfterMs = Number.isSafeInteger(delay) ? delay : undefined;
  const code = statusCode(status, retryAfterMs);
  return new AppError(code, {
    context: { status },
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function checkProviderError(error: unknown, retryAfter: string | null): void {
  if (error === undefined || error === null) return;
  const parsed = ProviderErrorSchema.safeParse(error);
  if (!parsed.success) throw new AppError("UPSTREAM_RESPONSE_INVALID");
  throw responseError(parsed.data.code, retryAfter);
}

export function decodeCompletion<Output>(
  body: string,
  retryAfter: string | null,
  schema: z.ZodType<Output>,
  accountUsage: (usage: LlmUsage) => void,
): { output: Output; model: string } {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new AppError("UPSTREAM_RESPONSE_INVALID");
  }
  const response = EnvelopeSchema.safeParse(value);
  if (!response.success) throw new AppError("UPSTREAM_RESPONSE_INVALID");
  const reported = UsageSchema.safeParse(response.data.usage);
  if (reported.success) {
    accountUsage({
      input_tokens: reported.data.prompt_tokens,
      output_tokens: reported.data.completion_tokens,
      cost_usd: reported.data.cost ?? null,
    });
  }
  checkProviderError(response.data.error, retryAfter);
  const choice = ChoiceSchema.safeParse(response.data.choices?.[0]);
  if (!choice.success) throw new AppError("UPSTREAM_RESPONSE_INVALID");
  checkProviderError(choice.data.error, retryAfter);
  if (choice.data.finish_reason === "error") throw new AppError("UPSTREAM_UNAVAILABLE");
  if (choice.data.finish_reason === "content_filter") throw new AppError("UPSTREAM_REJECTED");
  const message = MessageSchema.safeParse(choice.data.message);
  const model = ModelSchema.safeParse(response.data.model);
  if (!message.success || !model.success) throw new AppError("UPSTREAM_RESPONSE_INVALID");
  if (choice.data.finish_reason !== "stop" || message.data.content === null) {
    throw new AppError("LLM_OUTPUT_INVALID");
  }

  let output: unknown;
  try {
    output = JSON.parse(message.data.content);
  } catch {
    throw new AppError("LLM_OUTPUT_INVALID");
  }
  const validated = schema.safeParse(output);
  if (!validated.success) throw new AppError("LLM_OUTPUT_INVALID");
  if (!reported.success) throw new AppError("UPSTREAM_RESPONSE_INVALID");
  return { output: validated.data, model: model.data };
}

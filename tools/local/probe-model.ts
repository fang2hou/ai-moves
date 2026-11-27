// Local demo only: sends the product's real submission review request (the triage route's
// remaining model call) through the product's OpenRouter client, so a model's strict-JSON-schema
// behavior can be compared without running the pipeline.
import { isAppError } from "@ai-moves/kernel/errors/app-error";
import { createOpenRouterClient } from "@ai-moves/llm/openrouter";
import { renderSubmissionReviewPrompt } from "@ai-moves/prompts/review";

import { readEnv } from "./env.ts";

const key = readEnv("OPENROUTER_API_KEY") ?? "";
if (key === "") throw new Error("OPENROUTER_API_KEY is required");
const models = (readEnv("PROBE_MODELS") ?? "deepseek/deepseek-v4.1-flash-1017").split(",");
const attempts = Number(readEnv("PROBE_ATTEMPTS") ?? 3);

const prompt = renderSubmissionReviewPrompt({
  traceId: "probe-trace-0001",
  title: "Inkling-2-Mini in 5.4 GB Memory",
  sourceUrl: null,
  sourceName: null,
  excerpt: null,
  topics: ["AI engineering", "coding agents", "model releases", "developer tools"],
  lang: "en",
});

for (const model of models) {
  const route = { model: model.trim(), fallbacks: [], max_output_tokens: 700 };
  const llm = await createOpenRouterClient({
    fetch: (request) => fetch(request),
    secrets: { get: () => Promise.resolve(key) },
    secretRef: "OPENROUTER_API_KEY",
    models: { triage: route, polish: route, deep: route, translate: route },
    timeoutMs: 60_000,
  });
  const results: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { output, repaired } = await llm.generateStructured({ ...prompt, stage: "triage" });
      results.push(`score ${output.score}${repaired ? " after-repair" : ""}`);
    } catch (cause) {
      results.push(`FAILED ${isAppError(cause) ? cause.code : String(cause)}`);
    }
  }
  process.stdout.write(`${route.model}\n  ${results.join("\n  ")}\n`);
}

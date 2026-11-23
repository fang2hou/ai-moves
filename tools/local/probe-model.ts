// Local demo only: sends the product's real triage request through the product's OpenRouter
// client, so a model's strict-JSON-schema behavior can be compared without running the pipeline.
import { createOpenRouterClient } from "@ai-moves/llm/openrouter";
import { renderTriagePrompt } from "@ai-moves/prompts/triage";

const key = process.env.OPENROUTER_API_KEY ?? "";
if (key === "") throw new Error("OPENROUTER_API_KEY is required");
const models = (process.env.PROBE_MODELS ?? "deepseek/deepseek-v4.1-flash-1017").split(",");
const attempts = Number(process.env.PROBE_ATTEMPTS ?? 3);

const prompt = renderTriagePrompt({
  traceId: "probe-trace-0001",
  kind: "hn",
  title: "Inkling-2-Mini in 5.4 GB Memory",
  excerpt: null,
  topics: ["AI engineering", "coding agents", "model releases", "developer tools"],
});

for (const model of models) {
  const route = { model: model.trim(), fallbacks: [], max_output_tokens: 700 };
  const llm = await createOpenRouterClient({
    fetch: (request) => fetch(request),
    secrets: { get: () => Promise.resolve(key) },
    secretRef: "OPENROUTER_API_KEY",
    models: { triage: route, deep: route, translate: route },
    timeoutMs: 60_000,
  });
  const results: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await llm.generateStructured({ ...prompt, stage: "triage" });
      const output = result.output as { decision: string; confidence: number };
      results.push(
        `${output.decision}(${output.confidence})${result.repaired ? " after-repair" : ""}`,
      );
    } catch (cause) {
      results.push(`FAILED ${(cause as { code?: string }).code ?? String(cause)}`);
    }
  }
  process.stdout.write(`${route.model}\n  ${results.join("\n  ")}\n`);
}

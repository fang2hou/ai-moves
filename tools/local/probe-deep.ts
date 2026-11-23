// Scratch: runs the product's real deep prompt against candidate models on one
// release section, to compare how each honours the strict schema.
import { createOpenRouterClient } from "@ai-moves/llm/openrouter";
import { renderDeepPrompt } from "@ai-moves/prompts/deep";
import { splitChangelog } from "../../packages/ingestion/src/sections.ts";

const key = process.env.OPENROUTER_API_KEY ?? "";
const models = (process.env.PROBE_MODELS ?? "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const page = await (await fetch("https://antigravity.google/docs/changelog.md")).text();
const section = splitChangelog(page)[0];
if (section === undefined) throw new Error("no section");

const prompt = renderDeepPrompt({
  traceId: "probe-trace-0002",
  kind: "changelog",
  title: "Antigravity App v2.34.0",
  topics: ["AI engineering", "coding agents", "model releases", "developer tools"],
  products: ["Codex", "Claude", "GLM", "Antigravity"],
  lang: "zh-CN",
  evidence: [
    { locator: "https://antigravity.google/docs/changelog", text: section.notes.slice(0, 36000) },
  ],
});

for (const model of models) {
  const route = { model, fallbacks: [], max_output_tokens: 32_000 };
  const llm = await createOpenRouterClient({
    fetch: (request) => fetch(request),
    secrets: { get: () => Promise.resolve(key) },
    secretRef: "OPENROUTER_API_KEY",
    models: { triage: route, deep: route, translate: route },
    timeoutMs: 240_000,
  });
  try {
    const started = Date.now();
    const result = await llm.generateStructured({ ...prompt, stage: "deep" });
    const o = result.output as Record<string, unknown>;
    process.stdout.write(
      `\n=== ${model}  ${((Date.now() - started) / 1000).toFixed(0)}s${result.repaired ? " (repaired)" : ""}\n` +
        `summary: ${String(o.summary)}\n` +
        `points:\n${(o.key_points as { text: string; implication: string | null }[])
          .map(
            (p) => `  - ${p.text}${p.implication === null ? "" : `\n    [推测] ${p.implication}`}`,
          )
          .join("\n")}\n` +
        `citations: ${(o.citations as unknown[]).length}\n`,
    );
  } catch (cause) {
    process.stdout.write(
      `\n=== ${model}  FAILED ${String((cause as { code?: string }).code ?? cause)}\n`,
    );
  }
}

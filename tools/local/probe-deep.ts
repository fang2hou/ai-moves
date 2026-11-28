// Scratch: runs the product's real deep prompt against candidate models on one
// release section, to compare how each honours the strict schema.
import { systemClock } from "@ai-news-tracker/kernel/clock";
import { isAppError } from "@ai-news-tracker/kernel/errors/app-error";
import { createOpenRouterClient } from "@ai-news-tracker/llm/openrouter";
import { renderDeepPrompt } from "@ai-news-tracker/prompts/deep";

import { parseChangelog } from "../../packages/ingestion/src/parsers/registry.ts";
import { readEnv } from "./env.ts";

const key = readEnv("OPENROUTER_API_KEY") ?? "";
const models = (readEnv("PROBE_MODELS") ?? "")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const pageUrl = "https://antigravity.google/docs/changelog";
const page = await (await fetch(`${pageUrl}.md`)).text();
const section = parseChangelog(pageUrl, page)[0];
if (section === undefined) throw new Error("no section");

const prompt = renderDeepPrompt({
  traceId: "probe-trace-0002",
  kind: "changelog",
  title: "Antigravity App v2.34.0",
  topics: ["AI engineering", "coding agents", "model releases", "developer tools"],
  products: ["Codex", "Claude", "GLM", "Antigravity"],
  lang: "zh-CN",
  evidence: [{ locator: pageUrl, text: section.notes.slice(0, 36000) }],
});

for (const model of models) {
  const route = { model, fallbacks: [], max_output_tokens: 32_000 };
  const llm = await createOpenRouterClient({
    fetch: (request) => fetch(request),
    secrets: { get: () => Promise.resolve(key) },
    secretRef: "OPENROUTER_API_KEY",
    models: { triage: route, polish: route, deep: route, translate: route },
    timeoutMs: 240_000,
  });
  try {
    const started = systemClock.now();
    const { output, repaired } = await llm.generateStructured({ ...prompt, stage: "deep" });
    process.stdout.write(
      `\n=== ${model}  ${((systemClock.now() - started) / 1000).toFixed(0)}s${repaired ? " (repaired)" : ""}\n` +
        `summary: ${output.summary}\n` +
        `points:\n${output.key_points
          .map(
            (point) =>
              `  - ${point.text}${point.implication === null ? "" : `\n    [Implication] ${point.implication}`}`,
          )
          .join("\n")}\n` +
        `citations: ${output.citations.length}\n`,
    );
  } catch (cause) {
    process.stdout.write(
      `\n=== ${model}  FAILED ${isAppError(cause) ? cause.code : String(cause)}\n`,
    );
  }
}

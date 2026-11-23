import { AlertDocSchema, type AlertDoc } from "@ai-moves/contracts/alert-doc";
import type { Lang, TraceId } from "@ai-moves/contracts/primitives";
import { stableKey } from "@ai-moves/core/idempotency";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import {
  renderTranslationPrompt,
  TranslationOutputSchema,
  type TranslationOutput,
} from "@ai-moves/prompts/translate";

import {
  executionKey,
  readOutput,
  runAnalysis,
  type AnalysisDependencies,
  type ItemClaim,
} from "./work.ts";

export type TranslationLanguage = Exclude<Lang, "en">;
export type TranslationResult =
  | { readonly kind: "ready"; readonly document: AlertDoc | null }
  | { readonly kind: "retry"; readonly retryAfterMs: number }
  | { readonly kind: "stopped" };

export async function translateDocument(
  deps: AnalysisDependencies,
  claim: ItemClaim,
  deepId: string,
  original: AlertDoc,
  lang: TranslationLanguage,
  traceId: TraceId,
): Promise<TranslationResult> {
  const outcome = await runAnalysis(deps, claim, {
    key: translationKey(claim.item.id, deepId, original, lang),
    inputSchema: TranslationOutputSchema,
    prepare: () => Promise.resolve(proseOf(original)),
    prompt: (input) =>
      renderTranslationPrompt({
        traceId,
        targetLanguage: lang,
        alert: applyProse(original, input),
      }),
    normalize: (translated, input) => {
      if (!preservesFidelity(input, translated, lang)) throw new AppError("FIDELITY_CHECK_FAILED");
      return translated;
    },
  });
  if (outcome.kind === "retry" || outcome.kind === "stopped") return outcome;
  const output =
    outcome.kind === "completed" ? readOutput(outcome.row, TranslationOutputSchema) : null;
  return { kind: "ready", document: verifiedDocument(original, lang, output) };
}

export async function readTranslation(
  deps: AnalysisDependencies,
  itemId: string,
  deepId: string,
  original: AlertDoc,
  lang: TranslationLanguage,
): Promise<AlertDoc | null> {
  const row = await deps.analyses.findByKey(translationKey(itemId, deepId, original, lang));
  return row === null
    ? null
    : verifiedDocument(original, lang, readOutput(row, TranslationOutputSchema));
}

function translationKey(
  itemId: string,
  deepId: string,
  original: AlertDoc,
  lang: TranslationLanguage,
): ReturnType<typeof executionKey> {
  const input = stableKey("translation-input-v1", deepId, JSON.stringify(proseOf(original)));
  return executionKey(itemId, "translate", input, lang);
}

function proseOf(doc: AlertDoc): TranslationOutput {
  return {
    title: doc.title.original,
    summary: doc.summary,
    key_points: doc.key_points.map(({ text }) => text),
  };
}

function applyProse(original: AlertDoc, prose: TranslationOutput): AlertDoc {
  return {
    ...original,
    title: { original: prose.title, translated: null },
    summary: prose.summary,
    key_points: original.key_points.map((point, index) => ({
      ...point,
      text: prose.key_points[index] ?? point.text,
    })),
  };
}

function verifiedDocument(
  original: AlertDoc,
  lang: TranslationLanguage,
  output: TranslationOutput | null,
): AlertDoc | null {
  if (output === null || !preservesFidelity(proseOf(original), output, lang)) return null;
  return AlertDocSchema.parse({
    ...applyProse(original, output),
    title: { original: original.title.original, translated: output.title },
    lang,
    translation: { machine_translated: true, fell_back_to_english: false },
  });
}

const literalPattern =
  /```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s<>()]+|(?<![\p{L}\d])(?:[vV]?\d+(?:\.\d+)+(?:[-+][\w.-]+)?|\d+(?:%|\b))|--[\w-]+|(?:@[\w.-]+\/)?[\w.-]+\/[\w.-]+|\b(?:\w*[a-z][A-Z]\w*|[A-Za-z]\w*_\w+|[A-Z][A-Z0-9]+)\b/gu;
const namePattern = /\b[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)*\b/gu;
const commandPattern =
  /(?:^|[.!?:]\s+|\n)[ \t]*(?:\$\s*)?(?:cd|curl|docker|git|node|npm|pnpm|python|uv|yarn)\s+[ \t]*[^\n.;]+/gu;

function sameLiterals(original: string, translated: string): boolean {
  const before = [...original.matchAll(literalPattern)];
  const after = [...translated.matchAll(literalPattern)];
  if (before.length !== after.length || before.some((match, i) => match[0] !== after[i]?.[0])) {
    return false;
  }
  for (const [command] of original.matchAll(commandPattern)) {
    if (!translated.includes(command.trim())) return false;
  }
  for (const match of original.matchAll(namePattern)) {
    const name = match[0];
    const prefix = original.slice(0, match.index).trimEnd();
    const suffix = original.slice(match.index + name.length);
    if (
      (name.includes(" ") ||
        /^[ \t]+[A-Z][A-Z0-9]+\b/u.test(suffix) ||
        (prefix !== "" && !/[.!?:]$/u.test(prefix))) &&
      !new RegExp(`\\b${name}\\b`, "u").test(translated)
    ) {
      return false;
    }
  }
  return true;
}

function preservesFidelity(
  original: TranslationOutput,
  translated: TranslationOutput,
  lang: TranslationLanguage,
): boolean {
  const prose = translated.summary;
  const hasKana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(prose);
  if (lang === "ja" ? !hasKana : hasKana || !/\p{Script=Han}/u.test(prose)) return false;
  if (
    !sameLiterals(original.title, translated.title) ||
    !sameLiterals(original.summary, translated.summary)
  )
    return false;
  for (const field of ["key_points"] as const) {
    const before = original[field];
    const after = translated[field];
    if (
      before.length !== after.length ||
      before.some((text, index) => {
        const next = after[index];
        return next === undefined || !sameLiterals(text, next);
      })
    )
      return false;
  }
  return true;
}

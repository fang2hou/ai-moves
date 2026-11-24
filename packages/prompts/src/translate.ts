import {
  AlertDocSchema,
  AlertPointSchema,
  AlertTitleSchema,
  type AlertDoc,
} from "@ai-moves/contracts/alert-doc";
import type { Lang, TraceId } from "@ai-moves/contracts/primitives";
import { getLocale } from "@ai-moves/locales/registry";
import { z } from "zod";

import { renderPrompt, type RenderedPrompt } from "./render.ts";

export const TranslationOutputSchema = z.strictObject({
  ...AlertDocSchema.pick({ summary: true }).shape,
  title: AlertTitleSchema.shape.original,
  key_points: z.array(AlertPointSchema.shape.text).max(8),
});
export type TranslationOutput = z.infer<typeof TranslationOutputSchema>;

export interface TranslationPromptInput {
  readonly traceId: TraceId;
  readonly targetLanguage: Exclude<Lang, "en">;
  readonly alert: Pick<AlertDoc, "title" | "summary" | "key_points">;
}

export function renderTranslationPrompt({
  traceId,
  targetLanguage,
  alert,
}: TranslationPromptInput): RenderedPrompt<TranslationOutput> {
  const data: TranslationOutput = {
    title: alert.title.original,
    summary: alert.summary,
    key_points: alert.key_points.map(({ text }) => text),
  };
  const schema = TranslationOutputSchema.extend({
    key_points: TranslationOutputSchema.shape.key_points.length(data.key_points.length),
  });
  return renderPrompt(
    "translate",
    schema,
    traceId,
    [
      `Translate the supplied English text into ${getLocale(targetLanguage).englishName}.`,
      "Preserve meaning, uncertainty, list order, and list length. Do not summarize, add claims, or omit details.",
      "Preserve names, identifiers, code, commands, URLs, versions, and citations exactly as written.",
    ],
    data,
  );
}

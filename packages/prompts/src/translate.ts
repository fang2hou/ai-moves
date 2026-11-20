import {
  AlertDocSchema,
  AlertPointSchema,
  AlertTitleSchema,
  type AlertDoc,
} from "@ai-moves/contracts/alert-doc";
import type { Lang, TraceId } from "@ai-moves/contracts/primitives";
import { z } from "zod";

import { renderPrompt, type RenderedPrompt } from "./render.ts";

export const TranslationOutputSchema = z.strictObject({
  ...AlertDocSchema.pick({
    why_now: true,
    summary: true,
    engineering_implications: true,
    caveats: true,
  }).shape,
  title: AlertTitleSchema.shape.original,
  key_points: z.array(AlertPointSchema.shape.text).max(8),
});
export type TranslationOutput = z.infer<typeof TranslationOutputSchema>;

export interface TranslationPromptInput {
  readonly traceId: TraceId;
  readonly targetLanguage: Exclude<Lang, "en">;
  readonly alert: Pick<
    AlertDoc,
    "title" | "why_now" | "summary" | "key_points" | "engineering_implications" | "caveats"
  >;
}

const languageName = { "zh-CN": "Simplified Chinese", ja: "Japanese" } as const;

export function renderTranslationPrompt({
  traceId,
  targetLanguage,
  alert,
}: TranslationPromptInput): RenderedPrompt<TranslationOutput> {
  const data: TranslationOutput = {
    title: alert.title.original,
    why_now: alert.why_now,
    summary: alert.summary,
    key_points: alert.key_points.map(({ text }) => text),
    engineering_implications: alert.engineering_implications,
    caveats: alert.caveats,
  };
  const schema = TranslationOutputSchema.extend({
    key_points: TranslationOutputSchema.shape.key_points.length(data.key_points.length),
    engineering_implications: TranslationOutputSchema.shape.engineering_implications.length(
      data.engineering_implications.length,
    ),
    caveats: TranslationOutputSchema.shape.caveats.length(data.caveats.length),
  });
  return renderPrompt(
    "translate",
    schema,
    traceId,
    [
      `Translate the supplied English text into ${languageName[targetLanguage]}.`,
      "Preserve meaning, uncertainty, list order, and list length. Do not summarize, add claims, or omit details.",
      "Preserve names, identifiers, code, commands, URLs, versions, and citations exactly as written.",
    ],
    data,
  );
}

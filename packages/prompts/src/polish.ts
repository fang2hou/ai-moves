import { AlertPointSchema, type AlertDoc } from "@ai-news-tracker/contracts/alert-doc";
import type { TraceId } from "@ai-news-tracker/contracts/primitives";
import { getLocale } from "@ai-news-tracker/locales/registry";
import { z } from "zod";

import { renderPrompt, type RenderedPrompt } from "./render.ts";

// A last pass over a finished reading. It rewrites what is already there and may
// drop nothing: the count of points is pinned, so the model cannot quietly shorten
// the document, and every field keeps its own length limit.
export const PolishOutputSchema = z.strictObject({
  summary: z.string().min(1).max(220),
  key_points: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(180),
        implication: AlertPointSchema.shape.implication,
      }),
    )
    .max(10),
});
export type PolishOutput = z.infer<typeof PolishOutputSchema>;

export interface PolishPromptInput {
  readonly traceId: TraceId;
  readonly lang: AlertDoc["lang"];
  readonly summary: string;
  readonly points: readonly { readonly text: string; readonly implication: string | null }[];
}

export function renderPolishPrompt({
  traceId,
  lang,
  summary,
  points,
}: PolishPromptInput): RenderedPrompt<PolishOutput> {
  const { englishName, prompt } = getLocale(lang);
  const data: PolishOutput = {
    summary,
    key_points: points.map(({ text, implication }) => ({ text, implication })),
  };
  const schema = PolishOutputSchema.extend({
    key_points: PolishOutputSchema.shape.key_points.length(data.key_points.length),
  });
  return renderPrompt(
    "polish",
    schema,
    traceId,
    [
      `You are the last editor of a card a reader sees in a chat client. Return the same reading in ${englishName}, repaired.`,
      "Keep every point, in the same order, one for one. Never merge two, never drop one, never add one, and never move a fact from one point to another.",
      "Change only what is wrong. A sentence that already reads well comes back unchanged; rewriting for the sake of it loses detail.",
      // These are the failures this pass exists to catch, in the order they occur.
      `Delete any citation that leaked into the prose: a URL, a domain name, a bare marker such as [1] or [citation:2], and any clause beginning ${prompt.polishCitationExample}. The sentence ends where the prose ends.`,
      "Delete repeated or looping text. If a sentence repeats itself or trails into filler, keep the first clear statement and stop there.",
      "A point states one change. If a point has been packed with several, keep the one its first sentence is about and delete the rest; the others are not yours to move elsewhere.",
      "Cut a point that was left unfinished mid-sentence back to its last complete sentence.",
      "Keep identifiers, commands, flags, paths, settings, version strings, model names and product names exactly as written, including their backticks. Never translate them and never add markup of your own.",
      "An implication is one plain sentence on what the change means in practice. Set it to null when it only restates the point.",
      "Invent nothing. Every fact in your answer must already be in the text you were given.",
    ],
    data,
  );
}

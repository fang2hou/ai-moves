import type { Lang, TraceId } from "@ai-moves/contracts/primitives";
import { SubmissionReviewSchema } from "@ai-moves/contracts/scoring";
import { getLocale } from "@ai-moves/locales/registry";
import { z } from "zod";

import { renderPrompt, type RenderedPrompt } from "./render.ts";
import { SUBMISSION_REVIEW_PROMPT_VERSION } from "./versions.ts";

const MAX_COMMENT_CHARS = SubmissionReviewSchema.shape.comment.maxLength ?? 300;

// The stored comment is capped by the contract, but a model that runs a little long should still
// yield a review, so the schema accepts more and the normalizer cuts to the cap.
export const SubmissionReviewOutputSchema = z.strictObject({
  score: z.int().min(0).max(100),
  comment: z
    .string()
    .trim()
    .min(1)
    .max(MAX_COMMENT_CHARS * 3),
});
export type SubmissionReviewOutput = z.infer<typeof SubmissionReviewOutputSchema>;

export interface SubmissionReviewPromptInput {
  readonly traceId: TraceId;
  readonly title: string;
  readonly sourceUrl: string | null;
  readonly sourceName: string | null;
  readonly excerpt: string | null;
  readonly topics: readonly string[];
  readonly lang: Lang;
}

// Runs on the triage route. The submitter's name and email are never part of the input: the
// review judges the piece, not the person.
export function renderSubmissionReviewPrompt({
  traceId,
  title,
  sourceUrl,
  sourceName,
  excerpt,
  topics,
  lang,
}: SubmissionReviewPromptInput): RenderedPrompt<SubmissionReviewOutput> {
  const { englishName } = getLocale(lang);
  return {
    ...renderPrompt(
      "triage",
      SubmissionReviewOutputSchema,
      traceId,
      [
        "You review a web page a reader submitted to a desk that publishes only news about AI-assisted software engineering. Judge only how well the piece fits the desk's focus, using its title, source, and the supplied excerpt.",
        "The focus: AI development and model releases; using AI models; using AI to raise productivity; AI in real company work and operations; and accelerating software development with AI, such as coding agents, agent harnesses, and AI coding tools. The supplied topics are context only.",
        "A technical story where AI is peripheral is off-topic even when it is well written. Security incidents, lawsuits, business news, and general programming belong here unless the piece is itself about AI.",
        "Score from 0 to 100 as an integer: 80-100 when the piece is centrally about the focus and has concrete substance, such as specifics, numbers, methods, or first-hand experience; 60-79 when it is clearly about the focus but thin or generic; 30-59 when AI is mentioned but peripheral to the piece; 0-29 when it is off-topic.",
        "Promotion, unsupported claims, and generic commentary with no concrete substance do not score above 59, however closely the subject fits.",
        `Write comment in ${englishName}: one or two short sentences, at most 80 characters in Japanese or 140 in English, that a reader grasps at a glance. State the main reason for the score in plain words: what the piece is about and whether it fits the focus. Do not mention the numeric score, and do not address the submitter.`,
      ],
      { title, sourceUrl, sourceName, excerpt, topics, lang },
    ),
    promptVersion: SUBMISSION_REVIEW_PROMPT_VERSION,
    schemaName: SUBMISSION_REVIEW_PROMPT_VERSION,
  };
}

export function normalizeSubmissionReviewOutput(value: unknown): SubmissionReviewOutput {
  const { score, comment } = SubmissionReviewOutputSchema.parse(value);
  return {
    score,
    comment:
      comment.length > MAX_COMMENT_CHARS ? `${comment.slice(0, MAX_COMMENT_CHARS - 1)}…` : comment,
  };
}

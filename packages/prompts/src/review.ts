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
        "You review a web page a reader submitted to a news desk read by engineers at a financial company who adopt new technology eagerly and use AI in their daily development. Judge how useful the piece is to them, using its title, source, and the supplied excerpt.",
        "What they want most: AI development and model releases, using AI models, using AI to raise productivity, AI in real company work, accelerating software development with AI (coding agents, agent harnesses, AI coding tools), and how AI is changing their work, teams, companies, and society, including research and analysis of its effect on productivity, jobs, and how organizations work. Such a piece is AI-focused even without code, and its substance is its data, study design, or worked-out argument rather than implementation detail. They also want software engineering and developer tooling, including notable new features of the tools they use every day; security incidents with engineering substance or wide consequences, such as a major vulnerability or an incident that caused broad harm; and industry or market shifts that change how software is built or bought. The supplied topics are context only.",
        "Personal or gossip angles on people and companies have nothing for an engineer to learn, even when the company is technical.",
        "Score from 0 to 100 as an integer: 80-100 for AI-focused pieces with concrete substance, such as specifics, numbers, methods, a worked-out model or argument, or first-hand experience; 60-79 for AI-focused pieces that are thin, or for software engineering, security, or industry pieces with concrete substance an engineer can learn from; 30-59 for thin or generic pieces outside AI; 0-29 for gossip, promotion, or pieces with neither an engineering angle nor a bearing on how AI changes work.",
        "Promotion, unsupported claims, and generic commentary with no concrete substance do not score above 59, however closely the subject fits; a first-hand report on a new mainstream model or tool counts as substance when it says what the author actually did with it.",
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

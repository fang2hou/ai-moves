import { TriageAssessmentSchema, type TriageAssessment } from "@ai-moves/contracts/analysis";
import type { TraceId } from "@ai-moves/contracts/primitives";
import type { ItemKind } from "@ai-moves/contracts/states";
import { z } from "zod";

import { renderPrompt, type RenderedPrompt } from "./render.ts";

const rejectFields = TriageAssessmentSchema.options[1].shape;

export const TriageOutputSchema = z
  .strictObject({
    ...rejectFields,
    decision: z.enum(["pass", "reject"]),
    rejection_reason: rejectFields.rejection_reason.nullable(),
  })
  .refine(({ decision, rejection_reason: reason }) => (decision === "pass") === (reason === null), {
    path: ["rejection_reason"],
    message: "Use null for a pass and a reason for a rejection",
  });

export interface TriagePromptInput {
  readonly traceId: TraceId;
  readonly kind: ItemKind;
  readonly title: string;
  readonly excerpt: string | null;
  readonly topics: readonly string[];
}

export function renderTriagePrompt({
  traceId,
  kind,
  title,
  excerpt,
  topics,
}: TriagePromptInput): RenderedPrompt<z.infer<typeof TriageOutputSchema>> {
  return renderPrompt(
    "triage",
    TriageOutputSchema.safeExtend({ kind: z.literal(kind) }),
    traceId,
    [
      "Assess whether this item merits closer engineering analysis for the supplied topics.",
      "Pass only when the supplied evidence shows specific engineering relevance; reject generic commentary, promotion, and unsupported claims.",
      "Copy the supplied kind. Rate confidence in your decision from 0 to 1.",
      "For a pass set rejection_reason to null. For a rejection give a short, specific reason.",
    ],
    { kind, title, excerpt, topics },
  );
}

export function normalizeTriageOutput(value: unknown): TriageAssessment {
  const { rejection_reason, ...assessment } = TriageOutputSchema.parse(value);
  return TriageAssessmentSchema.parse(
    rejection_reason === null ? assessment : { ...assessment, rejection_reason },
  );
}

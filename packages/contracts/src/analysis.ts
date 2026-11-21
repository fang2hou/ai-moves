import { z } from "zod";

import { UnitIntervalSchema } from "./primitives.ts";
import { ItemKindSchema } from "./states.ts";

export const CitationSchema = z.strictObject({
  locator: z.string().min(1).max(2048),
  quote: z.string().min(1).max(1000),
});
export type Citation = z.infer<typeof CitationSchema>;

const triageFields = { kind: ItemKindSchema, confidence: UnitIntervalSchema };

export const TriageAssessmentSchema = z.discriminatedUnion("decision", [
  z.strictObject({ ...triageFields, decision: z.literal("pass") }),
  z.strictObject({
    ...triageFields,
    decision: z.literal("reject"),
    rejection_reason: z.string().min(1).max(500),
  }),
]);
export type TriageAssessment = z.infer<typeof TriageAssessmentSchema>;

const assessmentText = z.string().min(1).max(2000);
const deepFields = {
  confidence: UnitIntervalSchema,
  why_now: z.string().min(1).max(500),
  summary: assessmentText,
  key_points: z.array(assessmentText).max(8),
  engineering_implications: z.array(assessmentText).max(8),
  caveats: z.array(assessmentText).max(8),
  citations: z.array(CitationSchema).max(8),
};

export const HnDeepAssessmentSchema = z.strictObject({
  ...deepFields,
  kind: z.literal("hn"),
  importance: z.int().min(1).max(5),
});
export type HnDeepAssessment = z.infer<typeof HnDeepAssessmentSchema>;

export const ChangelogDeepAssessmentSchema = z.strictObject({
  ...deepFields,
  kind: z.literal("changelog"),
  impact: z.int().min(0).max(3),
});
export type ChangelogDeepAssessment = z.infer<typeof ChangelogDeepAssessmentSchema>;

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

// A card is read at a glance, so the shape is enforced here rather than asked for in
// prose: given room for two thousand characters a model will write an essay in one
// bullet, and no instruction reliably stops it.
const summaryText = z.string().min(1).max(220);
const pointText = z.string().min(1).max(180);
const implicationText = z.string().min(1).max(120);

// What the discussion thinks, in prose. Deliberately no percentages: a reader
// wants the mood and the strongest arguments on each side, not a tally.
export const CommunityViewSchema = z.strictObject({
  overall: z.enum(["positive", "mixed", "negative", "unclear"]),
  summary: assessmentText,
  supporting: z.array(assessmentText).max(5),
  opposing: z.array(assessmentText).max(5),
});
export type CommunityView = z.infer<typeof CommunityViewSchema>;

// One change, and separately what it means for the reader. The second half is a
// reading rather than a quotation of the source, so the page labels it as one and
// it is left out whenever the change speaks for itself.
// What kind of change a point reports. The card groups its points by this, so a
// reader sees at a glance whether a release breaks something or only adds to it.
export const PointCategorySchema = z.enum(["breaking", "new", "change", "fix"]);
export type PointCategory = z.infer<typeof PointCategorySchema>;

const pointFields = {
  text: pointText,
  implication: implicationText.nullable(),
};

// A release sorts into these four groups and the card is built around them, so the
// field is required: a model that may omit it will.
export const ChangelogPointSchema = z.strictObject({
  category: PointCategorySchema,
  ...pointFields,
});
export type ChangelogPoint = z.infer<typeof ChangelogPointSchema>;

// A discussion has releases of nothing to sort, so it carries no category at all.
export const HnPointSchema = z.strictObject(pointFields);
export type HnPoint = z.infer<typeof HnPointSchema>;

export type DeepPoint = ChangelogPoint | HnPoint;

const deepFields = {
  // The source headline rewritten in the output language; null when the source
  // headline is already in it.
  headline: z.string().min(1).max(300).nullable(),
  community_view: CommunityViewSchema.nullable(),
  confidence: UnitIntervalSchema,
  // Why this reading is worth publishing. Kept on the record with the alert's
  // decision; it is not part of the published page.
  why_now: z.string().min(1).max(500),
  summary: summaryText,
  citations: z.array(CitationSchema).max(8),
};

export const HnDeepAssessmentSchema = z.strictObject({
  ...deepFields,
  key_points: z.array(HnPointSchema).max(8),
  kind: z.literal("hn"),
  importance: z.int().min(1).max(5),
});
export type HnDeepAssessment = z.infer<typeof HnDeepAssessmentSchema>;

export const ChangelogDeepAssessmentSchema = z.strictObject({
  ...deepFields,
  key_points: z.array(ChangelogPointSchema).max(8),
  kind: z.literal("changelog"),
  impact: z.int().min(0).max(3),
});
export type ChangelogDeepAssessment = z.infer<typeof ChangelogDeepAssessmentSchema>;

// A submitted post or article reads like a story without its discussion: points without a
// release category, and an importance on the same scale as a Hacker News story.
export const SubmissionDeepAssessmentSchema = z.strictObject({
  ...deepFields,
  key_points: z.array(HnPointSchema).max(8),
  kind: z.literal("submission"),
  importance: z.int().min(1).max(5),
});
export type SubmissionDeepAssessment = z.infer<typeof SubmissionDeepAssessmentSchema>;

export type DeepAssessment = HnDeepAssessment | ChangelogDeepAssessment | SubmissionDeepAssessment;

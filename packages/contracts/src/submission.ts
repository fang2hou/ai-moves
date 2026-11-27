import { z } from "zod";

import { EntityIdSchema, EpochMsSchema, HttpsUrlSchema } from "./primitives.ts";
import { SubmissionModeSchema } from "./scoring.ts";
import { AlertBlockReasonSchema, AlertDecisionSchema, ItemStateSchema } from "./states.ts";

export const MAX_SUBMISSION_BODY_CHARS = 40_000;

// What a reader sends through the MCP `submit_item` tool. The body is markdown the reader's agent
// wrote from the source; it is evidence for the analysis and is never published as is.
export const SubmissionInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  // The public page the body was taken from. One item exists per URL, so a second submission of
  // the same page returns the first.
  source_url: HttpsUrlSchema,
  // Who published the source, as a reader would name them, e.g. "@karpathy on X".
  source_name: z.string().trim().min(1).max(100).nullable().default(null),
  published_at: EpochMsSchema.nullable().default(null),
  body: z.string().trim().min(1).max(MAX_SUBMISSION_BODY_CHARS),
  mode: SubmissionModeSchema.default("score"),
});
export type SubmissionInput = z.infer<typeof SubmissionInputSchema>;

export const SubmissionResultSchema = z.object({
  item_id: EntityIdSchema,
  // False when the URL had already been submitted; the existing item is returned unchanged.
  created: z.boolean(),
  state: ItemStateSchema,
  submitted_by: z.string(),
  detail_url: HttpsUrlSchema,
});
export type SubmissionResult = z.infer<typeof SubmissionResultSchema>;

// One row of the submissions dashboard (MCP tool `list_submissions`). Never carries an email.
export const SubmissionSummarySchema = z.object({
  item_id: EntityIdSchema,
  title: z.string(),
  url: z.string().nullable(),
  source_name: z.string().nullable(),
  submitted_by: z.string(),
  mode: SubmissionModeSchema,
  state: ItemStateSchema,
  submitted_at: EpochMsSchema,
  // The reviewer's verdict; for submissions rejected before the reviewer existed, the older
  // triage reason is shown as a comment with a null score.
  review: z
    .object({
      decision: z.enum(["pass", "reject"]),
      score: z.int().min(0).max(100).nullable(),
      comment: z.string(),
    })
    .nullable(),
  // The latest alert's outcome once deep analysis finished.
  alert: z
    .object({
      decision: AlertDecisionSchema,
      blocked_by: z.array(AlertBlockReasonSchema),
      importance: z.int().nullable(),
      // True only when a delivery of this alert actually reached a destination (not a dry run);
      // a `send` decision can still be held back by quiet hours or a disabled destination.
      delivered: z.boolean(),
    })
    .nullable(),
  forced_by: z.string().nullable(),
  // Whether `force_publish` accepts this item now.
  can_force: z.boolean(),
  detail_url: HttpsUrlSchema,
});
export type SubmissionSummary = z.infer<typeof SubmissionSummarySchema>;

export const SubmissionListSchema = z.object({ submissions: z.array(SubmissionSummarySchema) });
export type SubmissionList = z.infer<typeof SubmissionListSchema>;

// Submissions in these states can be forced: rejected by the reviewer, failed in analysis, or
// published to the desk without being sent.
export const FORCEABLE_SUBMISSION_STATES = [
  "triaged_reject",
  "failed_analysis",
  "feed_only",
] as const;

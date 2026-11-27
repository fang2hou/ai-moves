import { z } from "zod";

import { EntityIdSchema, EpochMsSchema, HttpsUrlSchema } from "./primitives.ts";
import { SubmissionModeSchema } from "./scoring.ts";
import { ItemStateSchema } from "./states.ts";

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

import { z } from "zod";

import {
  EntityIdSchema,
  EpochMsSchema,
  HttpUrlSchema,
  HttpsUrlSchema,
  LangSchema,
} from "./primitives.ts";
import { AlertKindSchema, AlertTierSchema, ItemKindSchema } from "./states.ts";

// Channel-neutral alert content from which the Slack and Discord renderers build their payloads
// (architecture 9.2). Every string is plain text and every URL comes from a field the program
// owns, never from model output (architecture 10).

export const AlertTextSchema = z.string().min(1).max(2000);

export const AlertTitleSchema = z.object({
  original: z.string().min(1).max(1000),
  translated: z.string().min(1).max(1000).nullable(),
});

export const AlertPointSchema = z.object({
  text: AlertTextSchema,
  evidence_quote: z.string().min(1).max(1000).nullable(),
  comment_id: z.string().min(1).max(32).nullable(),
});
export type AlertPoint = z.infer<typeof AlertPointSchema>;

export const AlertLinksSchema = z.object({
  source: HttpUrlSchema,
  discussion: HttpsUrlSchema.nullable(),
  detail: HttpsUrlSchema,
});

export const AlertTranslationSchema = z.object({
  machine_translated: z.boolean(),
  fell_back_to_english: z.boolean(),
});

export const AlertDocSchema = z.object({
  v: z.literal(1),
  alert_id: EntityIdSchema,
  kind: AlertKindSchema,
  item_kind: ItemKindSchema,
  tier: AlertTierSchema,
  lang: LangSchema,
  source_label: z.string().min(1).max(128),
  title: AlertTitleSchema,
  why_now: z.string().min(1).max(500),
  summary: AlertTextSchema,
  key_points: z.array(AlertPointSchema).max(8),
  engineering_implications: z.array(AlertTextSchema).max(8),
  caveats: z.array(AlertTextSchema).max(8),
  links: AlertLinksSchema,
  translation: AlertTranslationSchema,
  generated_at: EpochMsSchema,
});
export type AlertDoc = z.infer<typeof AlertDocSchema>;

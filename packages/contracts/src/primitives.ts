import { z } from "zod";

export const EpochMsSchema = z.int().nonnegative();
export type EpochMs = z.infer<typeof EpochMsSchema>;

export const EntityIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export type EntityId = z.infer<typeof EntityIdSchema>;

export const TraceIdSchema = EntityIdSchema;
export type TraceId = z.infer<typeof TraceIdSchema>;

export const ContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type ContentHash = z.infer<typeof ContentHashSchema>;

export const LANGS = ["en", "zh-CN", "ja"] as const;
export const LangSchema = z.enum(LANGS);
export type Lang = z.infer<typeof LangSchema>;

export const HttpUrlSchema = z.httpUrl().max(2048);
export type HttpUrl = z.infer<typeof HttpUrlSchema>;

export const HttpsUrlSchema = z.url({ protocol: /^https$/ }).max(2048);
export type HttpsUrl = z.infer<typeof HttpsUrlSchema>;

export const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;

export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((timeZone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone }).format(0);
      return true;
    } catch {
      return false;
    }
  }, "Unknown IANA time zone");
export type TimeZone = z.infer<typeof TimeZoneSchema>;

// A secret is referenced by name only, so a URL or token can never be stored where a reference
// is expected.
export const SecretRefSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const UnitIntervalSchema = z.number().min(0).max(1);
export const NonNegativeIntSchema = z.int().nonnegative();
export const PositiveIntSchema = z.int().positive();

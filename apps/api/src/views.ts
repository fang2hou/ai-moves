import { AlertDocSchema, type AlertDoc } from "@ai-news-tracker/contracts/alert-doc";
import type { Alert, Delivery, Item } from "@ai-news-tracker/contracts/entities";
import { type FeedQuery, FeedQuerySchema } from "@ai-news-tracker/contracts/ports/storage";
import { AppError } from "@ai-news-tracker/kernel/errors/app-error";
import { publicAlertDocument, publicLink } from "@ai-news-tracker/kernel/public-links";
import { z } from "zod";

const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/)
  .transform(Number);
const queryInput = z.strictObject({
  limit: decimal.optional(),
  before: z
    .string()
    .max(81)
    .regex(/^[0-9]+\.[A-Za-z0-9_-]+$/)
    .optional(),
});

export function readFeedQuery(input: unknown): FeedQuery {
  const fields = queryInput.safeParse(input);
  if (!fields.success) throw new AppError("INPUT_INVALID");
  const [at, id] = fields.data.before?.split(".") ?? [];
  const query = FeedQuerySchema.safeParse({
    limit: fields.data.limit ?? 25,
    ...(at === undefined ? {} : { before: { at: Number(at), id } }),
  });
  if (!query.success) throw new AppError("INPUT_INVALID");
  return query.data;
}

export function nextCursor(
  count: number,
  limit: number,
  last: { readonly at: number; readonly id: string } | undefined,
): string | null {
  return count === limit && last ? `${last.at}.${last.id}` : null;
}

type FeedItem = Pick<Item, "id" | "kind" | "url" | "title" | "state" | "tier" | "first_seen_at">;
export function itemView(item: Item): FeedItem {
  return {
    id: item.id,
    kind: item.kind,
    url: publicLink(item.url),
    title: item.title,
    state: item.state,
    tier: item.tier,
    first_seen_at: item.first_seen_at,
  };
}

const heatInput = z.strictObject({ days: decimal.optional() });

// The heat window in days: at most a month, so one request stays a bounded keyset walk.
export function readHeatDays(input: unknown): number {
  const fields = heatInput.safeParse(input);
  const days = fields.success ? (fields.data.days ?? 30) : 0;
  if (days < 1 || days > 30) throw new AppError("INPUT_INVALID");
  return days;
}

// Points and comments are the story's latest sampled Hacker News counts, already public there:
// the counts sampled after publication when there are any, else those it qualified with.
type HeatItem = FeedItem & { readonly points: number | null; readonly comments: number | null };
export function heatItemView(item: Item): HeatItem {
  const score = item.score_json?.kind === "hn" ? item.score_json : null;
  const counts = score?.latest ?? score?.features ?? null;
  return { ...itemView(item), points: counts?.points ?? null, comments: counts?.comments ?? null };
}

type FeedAlert = Pick<Alert, "id" | "item_id" | "kind" | "tier" | "decision" | "created_at">;
export function alertView(alert: Alert): FeedAlert {
  return {
    id: alert.id,
    item_id: alert.item_id,
    kind: alert.kind,
    tier: alert.tier,
    decision: alert.decision,
    created_at: alert.created_at,
  };
}

const documentViewSchema = AlertDocSchema.pick({
  source_label: true,
  title: true,
  summary: true,
  key_points: true,
  community_view: true,
  links: true,
  lang: true,
  translation: true,
  submitted_by: true,
});

export function documentView(document: AlertDoc): z.output<typeof documentViewSchema> | null {
  const publicDocument = publicAlertDocument(document);
  return publicDocument === null ? null : documentViewSchema.parse(publicDocument);
}

type DeliveryView = Pick<
  Delivery,
  "destination_id" | "state" | "lang" | "dry_run" | "suppressed_reason" | "state_updated_at"
>;
export function deliveryView(delivery: Delivery): DeliveryView {
  return {
    destination_id: delivery.destination_id,
    state: delivery.state,
    lang: delivery.lang,
    dry_run: delivery.dry_run,
    suppressed_reason: delivery.suppressed_reason,
    state_updated_at: delivery.state_updated_at,
  };
}

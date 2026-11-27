import { AlertDocSchema } from "@ai-moves/contracts/alert-doc";
import { AlertSchema, DeliverySchema, ItemSchema } from "@ai-moves/contracts/entities";
import { ErrorCodeSchema } from "@ai-moves/contracts/errors";
import type { Lang } from "@ai-moves/contracts/primitives";
import type { DeskErrorCode } from "@ai-moves/locales/types";
import { z } from "zod";

const feedItem = ItemSchema.pick({
  id: true,
  kind: true,
  url: true,
  title: true,
  state: true,
  tier: true,
  first_seen_at: true,
});
const feedAlert = AlertSchema.pick({
  id: true,
  item_id: true,
  kind: true,
  tier: true,
  decision: true,
  created_at: true,
});
const cursor = z.string().nullable();
// `next` comes from the API; the `before` in a link is typed by a reader, so it must match the
// shape the API emits and accepts: `<epoch milliseconds>.<entity id>`.
export const linkCursor = z
  .string()
  .max(81)
  .regex(/^[0-9]+\.[A-Za-z0-9_-]+$/);
const feed = z.object({ items: z.array(feedItem), next: cursor });
const heatItem = feedItem.extend({
  points: z.int().nonnegative().nullable(),
  comments: z.int().nonnegative().nullable(),
});
const heat = z.object({
  since: z.number(),
  until: z.number(),
  complete: z.boolean(),
  items: z.array(heatItem),
});
const itemDetail = z.object({ item: feedItem, alerts: z.array(feedAlert), next: cursor });
const alertDetail = z.object({
  alert: feedAlert,
  document: AlertDocSchema.pick({
    source_label: true,
    title: true,
    summary: true,
    key_points: true,
    community_view: true,
    links: true,
    lang: true,
    translation: true,
    submitted_by: true,
  }).nullable(),
  deliveries: z.array(
    DeliverySchema.pick({
      destination_id: true,
      state: true,
      lang: true,
      dry_run: true,
      suppressed_reason: true,
      state_updated_at: true,
    }),
  ),
});
const problem = z.object({ error: z.object({ code: ErrorCodeSchema }) });

export type FeedItem = z.output<typeof feedItem>;
export type FeedAlert = z.output<typeof feedAlert>;
export type HeatItem = z.output<typeof heatItem>;
export type HeatReport = z.output<typeof heat>;
export type AlertDetail = z.output<typeof alertDetail>;

type Transport = (path: string, init: RequestInit) => Promise<Response>;
type ReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: DeskErrorCode };

const unavailable = {
  ok: false,
  code: "UNAVAILABLE",
} as const;
const invalidResponse = {
  ok: false,
  code: "INVALID_RESPONSE",
} as const;

function failure(status: number, body: unknown): ReadResult<never> {
  if (status === 404) return { ok: false, code: "NOT_FOUND" };
  const error = problem.safeParse(body);
  if (error.success && error.data.error.code === "INPUT_INVALID") {
    return { ok: false, code: "INVALID_LINK" };
  }
  return unavailable;
}

function page(path: string, before: string | null, limit = 20): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before !== null) query.set("before", before);
  return `${path}?${query}`;
}

export interface DeskApi {
  feed(before: string | null): Promise<ReadResult<z.output<typeof feed>>>;
  item(id: string, before: string | null): Promise<ReadResult<z.output<typeof itemDetail>>>;
  alert(id: string, lang: Lang): Promise<ReadResult<AlertDetail>>;
  heat(days: number): Promise<ReadResult<HeatReport>>;
}

export function createDeskApi(transport: Transport): DeskApi {
  async function request<S extends z.ZodType>(
    path: string,
    schema: S,
  ): Promise<ReadResult<z.output<S>>> {
    try {
      const response = await transport(path, {
        credentials: "same-origin",
        redirect: "manual",
      });
      if (response.type === "opaqueredirect") return unavailable;
      const isJson = response.headers.get("Content-Type")?.startsWith("application/json");
      const value: unknown = isJson ? await response.json() : undefined;
      if (!response.ok) return failure(response.status, value);
      const result = schema.safeParse(value);
      return result.success ? { ok: true, value: result.data } : invalidResponse;
    } catch {
      return unavailable;
    }
  }

  return {
    feed: (before) => request(page("/api/feed", before), feed),
    // An item page opens only the newest alert, so it asks for a single row.
    item: (id, before) =>
      request(page(`/api/items/${encodeURIComponent(id)}`, before, 1), itemDetail),
    alert: (id, lang) =>
      request(
        `/api/alerts/${encodeURIComponent(id)}?${new URLSearchParams({ lang })}`,
        alertDetail,
      ),
    heat: (days) => request(`/api/heat?${new URLSearchParams({ days: String(days) })}`, heat),
  };
}

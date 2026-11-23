import { AlertDocSchema } from "@ai-moves/contracts/alert-doc";
import type { AppConfig } from "@ai-moves/contracts/config";
import {
  AlertSchema,
  ConfigVersionSchema,
  DeliverySchema,
  ItemSchema,
} from "@ai-moves/contracts/entities";
import { ErrorCodeSchema } from "@ai-moves/contracts/errors";
import { type DestinationPatch, DestinationSummarySchema } from "@ai-moves/contracts/ports/storage";
import type { Lang } from "@ai-moves/contracts/primitives";
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
const feed = z.object({ items: z.array(feedItem), next: cursor });
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
const configuration = z.object({
  current: ConfigVersionSchema.pick({ version: true, config: true, created_at: true }).nullable(),
});
const destinations = z.object({ destinations: z.array(DestinationSummarySchema) });
const session = z.object({ admin: z.boolean() });
const problem = z.object({ error: z.object({ code: ErrorCodeSchema }) });

export type FeedItem = z.output<typeof feedItem>;
export type FeedAlert = z.output<typeof feedAlert>;
export type AlertDetail = z.output<typeof alertDetail>;
export type Configuration = z.output<typeof configuration>["current"];

type Transport = (path: string, init: RequestInit) => Promise<Response>;
type ReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const unavailable = {
  ok: false,
  message: "The desk is unavailable. Reload to try again.",
} as const;
const invalidResponse = {
  ok: false,
  message: "The desk returned an unexpected response. Reload to try again.",
} as const;

function failure(status: number, body: unknown): ReadResult<never> {
  if (status === 401)
    return { ok: false, message: "Sign in through Cloudflare Access and reload." };
  if (status === 403) return { ok: false, message: "You don’t have access to these controls." };
  if (status === 404) return { ok: false, message: "This entry is no longer available." };
  if (status === 409) {
    return { ok: false, message: "Nothing was changed. Reload the controls before trying again." };
  }
  const error = problem.safeParse(body);
  if (error.success && error.data.error.code === "INPUT_INVALID") {
    return {
      ok: false,
      message: "The update is invalid or too large. Check the fields and try again.",
    };
  }
  return unavailable;
}

function page(path: string, before: string | null): string {
  const query = new URLSearchParams({ limit: "20" });
  if (before !== null) query.set("before", before);
  return `${path}?${query}`;
}

function mutation(method: "PUT" | "PATCH", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export interface DeskApi {
  session(): Promise<ReadResult<z.output<typeof session>>>;
  feed(before: string | null): Promise<ReadResult<z.output<typeof feed>>>;
  item(id: string, before: string | null): Promise<ReadResult<z.output<typeof itemDetail>>>;
  alert(id: string, lang: Lang): Promise<ReadResult<AlertDetail>>;
  destinations(): Promise<ReadResult<z.output<typeof destinations>>>;
  saveDestination(id: string, patch: DestinationPatch): Promise<ReadResult<undefined>>;
  configuration(): Promise<ReadResult<z.output<typeof configuration>>>;
  publish(
    expectedVersion: number,
    config: AppConfig,
  ): Promise<ReadResult<z.output<typeof configuration>>>;
}

export function createDeskApi(transport: Transport): DeskApi {
  async function request<S extends z.ZodType>(
    path: string,
    schema: S,
    init: RequestInit = {},
  ): Promise<ReadResult<z.output<S>>> {
    try {
      const response = await transport(path, {
        ...init,
        credentials: "same-origin",
        redirect: "manual",
      });
      if (response.type === "opaqueredirect") return failure(401, undefined);
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
    session: () => request("/api/session", session),
    feed: (before) => request(page("/api/feed", before), feed),
    item: (id, before) => request(page(`/api/items/${encodeURIComponent(id)}`, before), itemDetail),
    alert: (id, lang) =>
      request(
        `/api/alerts/${encodeURIComponent(id)}?${new URLSearchParams({ lang })}`,
        alertDetail,
      ),
    destinations: () => request("/api/admin/destinations", destinations),
    saveDestination: (id, patch) =>
      request(
        `/api/admin/destinations/${encodeURIComponent(id)}`,
        z.undefined(),
        mutation("PATCH", patch),
      ),
    configuration: () => request("/api/admin/config", configuration),
    publish: (expectedVersion, config) =>
      request("/api/admin/config", configuration, mutation("PUT", { expectedVersion, config })),
  };
}

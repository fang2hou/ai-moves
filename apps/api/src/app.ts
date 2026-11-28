import type { Item } from "@ai-news-tracker/contracts/entities";
import type { ErrorCode } from "@ai-news-tracker/contracts/errors";
import type { Clock } from "@ai-news-tracker/contracts/ports/runtime";
import {
  type AlertRepo,
  type ConfigStore,
  type DeliveryRepo,
  type FeedQuery,
  type ItemRepo,
} from "@ai-news-tracker/contracts/ports/storage";
import { EntityIdSchema, LANGS, LangSchema } from "@ai-news-tracker/contracts/primitives";
import { AppError, toAppError } from "@ai-news-tracker/kernel/errors/app-error";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { z } from "zod";

import {
  alertView,
  deliveryView,
  documentView,
  heatItemView,
  itemView,
  nextCursor,
  readFeedQuery,
  readHeatDays,
} from "./views.ts";

const DAY_MS = 86_400_000;
// 20 pages of 100 cover a month at well over the current publishing rate.
const HEAT_PAGE = 100;
const HEAT_MAX_PAGES = 20;

interface ApiDependencies {
  readonly items: Pick<ItemRepo, "get" | "listFeed">;
  readonly alerts: Pick<AlertRepo, "get" | "getDocument" | "listFeed">;
  readonly deliveries: Pick<DeliveryRepo, "listByAlert">;
  readonly config: Pick<ConfigStore, "getCurrent">;
  readonly clock: Clock;
  readonly assets?: { fetch(request: Request): Promise<Response> } | undefined;
}

function validate<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError("INPUT_INVALID");
  return result.data;
}

const feedQuery = validator("query", (query) => readFeedQuery(query));
const heatQuery = validator("query", (query) => readHeatDays(query));
const language = validator("query", (query) =>
  validate(z.strictObject({ lang: LangSchema.default("en") }), query),
);
const errorStatuses = {
  INPUT_INVALID: 400,
  NOT_FOUND: 404,
  STORAGE_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const satisfies Partial<Record<ErrorCode, number>>;

function errorResponse(code: keyof typeof errorStatuses): Response {
  return Response.json({ error: { code } }, { status: errorStatuses[code] });
}

function isPublicError(code: ErrorCode): code is keyof typeof errorStatuses {
  return Object.hasOwn(errorStatuses, code);
}

function visible(item: Item): boolean {
  return item.state === "alerted" || item.state === "feed_only";
}

export function createApi(deps: ApiDependencies): Hono {
  const app = new Hono();

  app.onError((error) => {
    if (error instanceof HTTPException && error.status === 400) {
      return errorResponse("INPUT_INVALID");
    }
    const { code } = toAppError(error);
    return errorResponse(isPublicError(code) ? code : "INTERNAL");
  });
  app.notFound(() => errorResponse("NOT_FOUND"));
  app.use("*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
    const { headers } = context.res;
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set(
      "Content-Security-Policy",
      // Repository owners are identified by their GitHub avatar, the one remote
      // asset the desk loads.
      "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
  });
  app.get("/healthz", async (context) => {
    await deps.config.getCurrent();
    return context.json({ status: "ok" });
  });
  // Reads are public: the desk is a published page, and every document it can
  // serve has already passed the public-link rules in `publicAlertDocument`.
  app.get("/api/feed", feedQuery, async (context) => {
    const query = context.req.valid("query");
    const rows = await deps.items.listFeed(query);
    const last = rows.at(-1);
    return context.json({
      items: rows.map(itemView),
      next: nextCursor(rows.length, query.limit, last && { at: last.first_seen_at, id: last.id }),
    });
  });
  // Every published item first seen in the last `days` days, for the desk's heat page to
  // aggregate. `complete` is false only when the page cap cut the window short.
  app.get("/api/heat", heatQuery, async (context) => {
    const until = deps.clock.now();
    const since = until - context.req.valid("query") * DAY_MS;
    const rows: Item[] = [];
    let before: FeedQuery["before"];
    let complete = false;
    for (let page = 0; page < HEAT_MAX_PAGES && !complete; page += 1) {
      const batch = await deps.items.listFeed({
        limit: HEAT_PAGE,
        ...(before === undefined ? {} : { before }),
      });
      const afterSince = batch.filter((item) => item.first_seen_at >= since);
      // An item first seen while this request runs is newer than `until`; leave it out.
      rows.push(...afterSince.filter((item) => item.first_seen_at <= until));
      const last = batch.at(-1);
      complete = last === undefined || afterSince.length < batch.length || batch.length < HEAT_PAGE;
      if (last !== undefined) before = { at: last.first_seen_at, id: last.id };
    }
    return context.json({ since, until, complete, items: rows.map(heatItemView) });
  });
  app.get("/api/items/:id", feedQuery, async (context) => {
    const id = validate(EntityIdSchema, context.req.param("id"));
    const item = await deps.items.get(id);
    if (item === null || !visible(item)) return errorResponse("NOT_FOUND");
    return context.json({
      item: itemView(item),
      ...(await alertPage(context.req.valid("query"), id)),
    });
  });
  app.get("/api/alerts", feedQuery, async (context) =>
    context.json(await alertPage(context.req.valid("query"))),
  );
  app.get("/api/alerts/:id", language, async (context) => {
    const id = validate(EntityIdSchema, context.req.param("id"));
    const alert = await deps.alerts.get(id);
    if (alert === null) return errorResponse("NOT_FOUND");
    // Documents are published in one configured language; serve whichever one
    // exists rather than an empty page when the query names another.
    const requested = context.req.valid("query").lang;
    const [document, deliveries] = await Promise.all([
      (async () => {
        for (const lang of [requested, ...LANGS.filter((entry) => entry !== requested)]) {
          const found = await deps.alerts.getDocument(id, lang);
          if (found !== null) return found;
        }
        return null;
      })(),
      deps.deliveries.listByAlert(id),
    ]);
    return context.json({
      alert: alertView(alert),
      document: document === null ? null : documentView(document),
      deliveries: deliveries.map(deliveryView),
    });
  });

  app.get("*", (context) => {
    if (
      context.req.path === "/api" ||
      context.req.path.startsWith("/api/") ||
      deps.assets === undefined
    ) {
      return errorResponse("NOT_FOUND");
    }
    const url = new URL(context.req.url);
    if (
      url.pathname === "/heat" ||
      url.pathname === "/submissions" ||
      /^\/(?:items|alerts)\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname)
    ) {
      url.pathname = "/";
    }
    return deps.assets.fetch(new Request(url, { method: context.req.method }));
  });

  return app;

  async function alertPage(query: FeedQuery, itemId?: string) {
    const rows = await deps.alerts.listFeed({
      ...query,
      ...(itemId === undefined ? {} : { itemId }),
    });
    const last = rows.at(-1);
    return {
      alerts: rows.map(alertView),
      next: nextCursor(rows.length, query.limit, last && { at: last.created_at, id: last.id }),
    };
  }
}

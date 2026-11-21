import { AppConfigSchema, cloudflarePipelineConfigIssue } from "@ai-moves/contracts/config";
import type { Item } from "@ai-moves/contracts/entities";
import type { ErrorCode } from "@ai-moves/contracts/errors";
import type { Clock, IdGen } from "@ai-moves/contracts/ports/runtime";
import {
  type AdminChange,
  type AdminRepo,
  type AlertRepo,
  type ConfigStore,
  type DeliveryRepo,
  DestinationPatchSchema,
  DestinationSummarySchema,
  type FeedQuery,
  type ItemRepo,
} from "@ai-moves/contracts/ports/storage";
import { EntityIdSchema, LangSchema, NonNegativeIntSchema } from "@ai-moves/contracts/primitives";
import { AppError, toAppError } from "@ai-moves/kernel/errors/app-error";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { z } from "zod";

import type { Identity, VerifyAccess } from "./access.ts";
import {
  alertView,
  configView,
  deliveryView,
  documentView,
  itemView,
  nextCursor,
  readFeedQuery,
} from "./views.ts";

interface ApiDependencies {
  readonly verifyAccess: VerifyAccess;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly items: Pick<ItemRepo, "get" | "listFeed">;
  readonly alerts: Pick<AlertRepo, "get" | "getDocument" | "listFeed">;
  readonly deliveries: Pick<DeliveryRepo, "listByAlert">;
  readonly config: Pick<ConfigStore, "getCurrent">;
  readonly admin: AdminRepo;
  readonly assets?: { fetch(request: Request): Promise<Response> } | undefined;
}

type ApiEnvironment = { Variables: { identity: Identity } };
type ApiApp = Hono<ApiEnvironment>;
const publishSchema = z.strictObject({
  expectedVersion: NonNegativeIntSchema,
  config: AppConfigSchema.refine((config) => cloudflarePipelineConfigIssue(config) === undefined),
});

function validate<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError("INPUT_INVALID");
  return result.data;
}

const feedQuery = validator("query", (query) => readFeedQuery(query));
const language = validator("query", (query) =>
  validate(z.strictObject({ lang: LangSchema.default("en") }), query),
);
const destinationPatch = validator("json", (body) => validate(DestinationPatchSchema, body));
const configPublish = validator("json", (body) => validate(publishSchema, body));
const protectedBody = bodyLimit({
  maxSize: 64 * 1024,
  onError: () => errorResponse("INPUT_INVALID", 413),
});

const errorStatuses = {
  INPUT_INVALID: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  STORAGE_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const satisfies Partial<Record<ErrorCode, number>>;

function errorResponse(
  code: keyof typeof errorStatuses,
  status: (typeof errorStatuses)[keyof typeof errorStatuses] | 413 = errorStatuses[code],
): Response {
  return Response.json({ error: { code } }, { status });
}

function isPublicError(code: ErrorCode): code is keyof typeof errorStatuses {
  return Object.hasOwn(errorStatuses, code);
}

function visible(item: Item): boolean {
  return item.state === "alerted" || item.state === "feed_only";
}

export function createApi(deps: ApiDependencies): ApiApp {
  const app = new Hono<ApiEnvironment>();

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
      "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
  });
  app.get("/healthz", async (context) => {
    await deps.config.getCurrent();
    return context.json({ status: "ok" });
  });
  app.use("*", async (context, next) => {
    const identity = await deps.verifyAccess(context.req.header("Cf-Access-Jwt-Assertion"));
    if (identity === null) return errorResponse("UNAUTHENTICATED");
    context.set("identity", identity);
    return next();
  });
  app.use("/api/admin/*", async (context, next) => {
    if (!context.var.identity.admin) return errorResponse("FORBIDDEN");
    if (context.req.method !== "GET") {
      const origin = context.req.header("Origin");
      if (origin !== undefined && origin !== new URL(context.req.url).origin) {
        return errorResponse("FORBIDDEN");
      }
    }
    return next();
  });

  app.get("/api/session", (context) => context.json({ admin: context.var.identity.admin }));
  app.get("/api/feed", feedQuery, async (context) => {
    const query = context.req.valid("query");
    const rows = await deps.items.listFeed(query);
    const last = rows.at(-1);
    return context.json({
      items: rows.map(itemView),
      next: nextCursor(rows.length, query.limit, last && { at: last.first_seen_at, id: last.id }),
    });
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
    const [document, deliveries] = await Promise.all([
      deps.alerts.getDocument(id, context.req.valid("query").lang),
      deps.deliveries.listByAlert(id),
    ]);
    return context.json({
      alert: alertView(alert),
      document: document === null ? null : documentView(document),
      deliveries: deliveries.map(deliveryView),
    });
  });

  app.get("/api/admin/destinations", async (context) =>
    context.json({
      destinations: (await deps.admin.listDestinations()).map((row) =>
        DestinationSummarySchema.parse(row),
      ),
    }),
  );
  app.patch("/api/admin/destinations/:id", protectedBody, destinationPatch, async (context) => {
    const id = validate(EntityIdSchema, context.req.param("id"));
    const patched = await deps.admin.patchDestination(
      id,
      context.req.valid("json"),
      adminChange(context.var.identity),
    );
    return patched ? context.body(null, 204) : errorResponse("STATE_CONFLICT");
  });
  app.get("/api/admin/config", async (context) =>
    context.json({ current: configView(await deps.config.getCurrent()) }),
  );
  app.put("/api/admin/config", protectedBody, configPublish, async (context) => {
    const { config, expectedVersion } = context.req.valid("json");
    const current = await deps.admin.publishConfig(
      config,
      expectedVersion,
      adminChange(context.var.identity),
    );
    return current === null
      ? errorResponse("STATE_CONFLICT")
      : context.json({ current: configView(current) });
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
      url.pathname === "/controls" ||
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

  function adminChange(identity: Identity): AdminChange {
    return { actor: identity.actor, id: deps.ids.next(), at: deps.clock.now() };
  }
}

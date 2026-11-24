# AI Moves Desk Worker

One Cloudflare Worker serves the public desk: the static assets built by [`apps/web`](../web/README.md) and a read API over the pipeline's D1 database. It binds no provider or notifier credentials.

```sh
pnpm --filter @ai-moves/web build   # assets in apps/web/dist, served through ASSETS
pnpm --filter @ai-moves/api build   # Worker bundle check (Vite); CI runs both
```

## Bindings

| Name     | Value                                                        |
| -------- | ------------------------------------------------------------ |
| `DB`     | The environment's D1 database (`ai-moves-dev` or `ai-moves`) |
| `ASSETS` | Static assets from `apps/web/dist`                           |

`dev` is served at `ai-moves-desk-dev.fang2hou.workers.dev`; `prod` at the custom domain `moves.lineyahoo.dev` with `workers_dev` disabled.

## Endpoints

| Method and path             | Result                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /healthz`              | Reads the current configuration row from D1 and returns `{"status":"ok"}`, even when none is published |
| `GET /api/feed`             | Published items (`feed_only` or `alerted`), newest first                                               |
| `GET /api/items/:id`        | A published item and its alerts, newest first                                                          |
| `GET /api/alerts`           | Alert summaries, newest first                                                                          |
| `GET /api/alerts/:id?lang=` | Alert, its document in the requested language or any stored one, and delivery states                   |
| Any other `GET`             | A static asset; `/items/:id` and `/alerts/:id` serve the desk's `index.html`                           |

Reads are public. Paged endpoints take `limit` (default 25) and `before` (the previous response's opaque `next`); they are live keyset reads, not snapshots. Every document passes `publicAlertDocument` before it is served (see [docs/public-links.md](../../docs/public-links.md)). Errors are `{ "error": { "code": ... } }` with only the public error codes.

## Security headers

The Worker middleware sets `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a `Content-Security-Policy` that allows only same-origin resources plus GitHub avatars. A request that matches a static file is served by the platform without running the Worker, so `apps/web/public/_headers` sets the same three security headers for assets; keep the two in step.

## Pull request previews

The Desk Worker is read-only and serves public requests without authentication. The former session and administrative endpoints return 404.

Same-repository pull requests use the [Desk PR Preview workflow](../../.github/workflows/preview.yml). The GitHub `preview` environment supplies `CLOUDFLARE_ACCOUNT_ID` and a dedicated `CLOUDFLARE_PREVIEW_API_TOKEN` with the minimum Workers permissions needed to upload the preview. Each alias serves a version of `ai-moves-desk-dev` with static assets and the existing `ai-moves-dev` D1 binding (`5bcc51a7-b879-4a33-ab9a-7a473041125b`). The workflow excludes production resources, the pipeline, and D1 migrations.

## Dependencies

- Hono provides routing and middleware that run unchanged on Workers.
- Vite bundles the Worker for the build check and the desk assets; `tsc` checks types but does not bundle.

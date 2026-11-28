# AI News Tracker Desk Worker

One Cloudflare Worker serves the public desk: the static assets built by [`apps/web`](../web/README.md) and a read API over the pipeline's D1 database. It binds no provider or notifier credentials.

```sh
mise run build   # desk assets in apps/web/dist, served through ASSETS, and the Worker bundle check (Vite)
```

## Bindings

| Name     | Value                                                                             |
| -------- | --------------------------------------------------------------------------------- |
| `DB`     | The environment's D1 database (legacy Phase 1 names `ai-moves-dev` or `ai-moves`) |
| `ASSETS` | Static assets from `apps/web/dist`                                                |

The Worker names below still carry their legacy Phase 1 `ai-moves-*` names until the cutover in [docs/rename-migration.md](../../docs/rename-migration.md): `dev` is served at `ai-moves-desk-dev.fang2hou.workers.dev`; `prod` uses the custom domain `moves.lineyahoo.dev` with `workers_dev` disabled.

## Endpoints

| Method and path             | Result                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /healthz`              | Reads the current configuration row from D1 and returns `{"status":"ok"}`, even when none is published |
| `GET /api/feed`             | Published items (`feed_only` or `alerted`), newest first                                               |
| `GET /api/items/:id`        | A published item and its alerts, newest first                                                          |
| `GET /api/heat?days=`       | Published items first seen in the last `days` (1–30, default 30), with HN points and comments          |
| `GET /api/alerts`           | Alert summaries, newest first                                                                          |
| `GET /api/alerts/:id?lang=` | Alert, its document in the requested language or any stored one, and delivery states                   |
| Any other `GET`             | A static asset; `/heat`, `/submissions`, `/items/:id`, and `/alerts/:id` serve the desk's `index.html` |

`src/lambda.ts` serves the same read API from AWS Lambda over the DynamoDB adapter (`mise run build-lambda` bundles `src/handler.ts`, handler `index.handler`, configured by `TABLE_NAME` and the Lambda runtime's AWS variables). It serves no static assets: a path outside `/api` and `/healthz` answers `NOT_FOUND`.

Reads are public. Paged endpoints take `limit` (default 25) and `before` (the previous response's opaque `next`); they are live keyset reads, not snapshots. `/api/heat` walks the feed in pages of 100 up to 2,000 items and sets `complete: false` when that cap cut the window short. A document on a submitted item carries `submitted_by`, the submitter's display name; the submitter's email is never served. Every document passes `publicAlertDocument` before it is served (see [docs/public-links.md](../../docs/public-links.md)). Errors are `{ "error": { "code": ... } }` with only the public error codes.

## Security headers

The Worker middleware sets `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a `Content-Security-Policy` that allows only same-origin resources plus GitHub avatars. A request that matches a static file is served by the platform without running the Worker, so `apps/web/public/_headers` sets the same three security headers for assets; keep the two in step.

## Read-only desk

The desk serves public reads and static assets. The former `/controls` UI, `/api/session` and `/api/admin/*` routes, Cloudflare Access verifier (`access.ts`), and `jose` dependency were removed. The Desk Worker is read-only and serves public requests without authentication: the former session and administrative endpoints return 404. The existing D1 schema and migration history still apply.

## Pull request previews

Same-repository pull requests use the [Desk PR Preview workflow](../../.github/workflows/preview.yml). The GitHub `preview` environment supplies `CLOUDFLARE_ACCOUNT_ID` and a dedicated `CLOUDFLARE_PREVIEW_API_TOKEN` with the minimum Workers permissions needed to upload the preview. Each alias serves a version of the legacy Phase 1 `ai-moves-desk-dev` Worker with static assets and the existing `ai-moves-dev` D1 binding (`5bcc51a7-b879-4a33-ab9a-7a473041125b`) until the cutover in [docs/rename-migration.md](../../docs/rename-migration.md). The workflow excludes production resources, the pipeline, and D1 migrations.

## Dependencies

- Hono provides routing and middleware that run unchanged on Workers.
- Vite bundles the Worker for the build check and the desk assets; `tsc` checks types but does not bundle.

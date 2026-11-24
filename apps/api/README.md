# AI Moves Desk Worker

One Cloudflare Worker serves the public desk: the static assets built by [`apps/web`](../web/README.md) and a read API over the pipeline's D1 database. It binds no provider or notifier credentials.

```sh
pnpm --filter @ai-moves/web build   # assets in apps/web/dist, served through ASSETS
pnpm --filter @ai-moves/api build   # Worker bundle check (Vite); CI runs both
```

## Bindings

| Name                    | Value                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `DB`                    | The environment's D1 database (`ai-moves-dev` or `ai-moves`)                                          |
| `ASSETS`                | Static assets from `apps/web/dist`                                                                    |
| `ACCESS_*` (deprecated) | `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, `ACCESS_JWKS`, `ACCESS_ADMIN_SUBJECTS`; unset in `wrangler.jsonc` |

`dev` is served at `ai-moves-desk-dev.fang2hou.workers.dev`; `prod` at the custom domain `moves.lineyahoo.dev` with `workers_dev` disabled.

## Endpoints

| Method and path             | Result                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /healthz`              | Reads the current configuration from D1 and returns `{"status":"ok"}`                      |
| `GET /api/feed`             | Published items (`feed_only` or `alerted`), newest first                                   |
| `GET /api/items/:id`        | A published item and its alerts, newest first                                              |
| `GET /api/alerts`           | Alert summaries, newest first                                                              |
| `GET /api/alerts/:id?lang=` | Alert, its document in the requested language or any stored one, and delivery states       |
| `GET /api/session`          | Deprecated: whether the caller's Access identity is an administrator                       |
| `/api/admin/*`              | Deprecated: destination summaries and patches, configuration read and publish              |
| Any other `GET`             | A static asset; `/controls`, `/items/:id`, and `/alerts/:id` serve the desk's `index.html` |

Reads are public. Paged endpoints take `limit` (default 25) and `before` (the previous response's opaque `next`); they are live keyset reads, not snapshots. Every document passes `publicAlertDocument` before it is served (see [docs/public-links.md](../../docs/public-links.md)). Errors are `{ "error": { "code": ... } }` with only the public error codes.

## Security headers

The Worker middleware sets `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a `Content-Security-Policy` that allows only same-origin resources plus GitHub avatars. A request that matches a static file is served by the platform without running the Worker, so `apps/web/public/_headers` sets the same three security headers for assets; keep the two in step.

## Deprecated admin path

`/api/admin/*` and `/api/session` verify the `Cf-Access-Jwt-Assertion` header in `src/access.ts` (RS256, pinned issuer and audience, a key ID, an application token, and an allowlisted subject for admin). Without valid `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, and `ACCESS_JWKS` settings the verifier returns no identity, so admin routes answer 401 and `/api/session` reports `{"admin":false}`. Writes take JSON up to 64 KiB and reject a cross-origin `Origin`. `PUT /api/admin/config` also rejects any model route whose provider is not `openrouter`.

The product is a public blog with no login and no admin UI: these routes, `src/access.ts`, and the `jose` dependency are scheduled for removal, and configuration is published through the deployment seed (`tools/local/seed-sql.ts`) instead.

## Dependencies

- Hono provides routing and middleware that run unchanged on Workers.
- JOSE verifies the deprecated Access tokens and leaves with them.
- Vite bundles the Worker for the build check and the desk assets; `tsc` checks types but does not bundle.

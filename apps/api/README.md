# AI Moves API

The Worker serves the public desk: the pages built from `apps/web` as static assets, and the API that reads feed and alert data from D1. It binds no provider or notifier credential (`src/worker.ts`).

## Build

```sh
pnpm --filter @ai-moves/web build
pnpm --filter @ai-moves/api build
```

CI runs both after `mise run check`. The API build bundles `src/worker.ts` with Vite and does not read the desk's output. The local demo in `tools/local` serves this bundle together with the desk's pages. A change to a route is verified by driving `createApi` from `src/app.ts` with plain objects in a throwaway script.

## Bindings

| Name                    | Value                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `DB`                    | D1 binding with the storage migrations applied.                                             |
| `ASSETS`                | Static assets binding for `apps/web/dist`.                                                  |
| `ACCESS_ISSUER`         | The exact Access team origin, `https://<team>.cloudflareaccess.com`.                        |
| `ACCESS_AUDIENCE`       | The Access application's AUD tag.                                                           |
| `ACCESS_JWKS`           | JSON containing the team's public RSA signing `keys` from its Access certificates endpoint. |
| `ACCESS_ADMIN_SUBJECTS` | JSON array of operator Access `sub` identifiers. Omit it for no administrators.             |

The desk is public ([ADR-0004](../../docs/adr/0004-public-desk-access-for-administration.md)). Only `/api/admin/*` and `/api/session` read the four `ACCESS_*` variables, and the verifier fails closed: unless `ACCESS_ISSUER`, `ACCESS_AUDIENCE` and `ACCESS_JWKS` are all present and well formed, it rejects every identity (`src/access.ts`). Neither environment in `wrangler.jsonc` sets one, so a deployed desk has no administrator. `/api/admin/*` answers `401 UNAUTHENTICATED` and `/api/session` answers `{"admin":false}`.

On a protected route the Worker verifies `Cf-Access-Jwt-Assertion`. It pins RS256, the team issuer, and the application audience; requires a key ID, an unexpired application token, and a user subject; and accepts no service-token identity. Admin permission comes only from the configured subject list.

Public keys are configuration, not credentials. This Worker does not fetch keys in the request path: the deployment operator must supply the current and previous Access signing keys and refresh the binding at rotation. Unknown keys and invalid configuration fail closed.

## Endpoints

| Method and path                     | Caller        | Result                                                                                                                                          |
| ----------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                      | anyone        | Dependency readiness, with no configuration or binding contents.                                                                                |
| `GET /api/session`                  | anyone        | Whether the caller is an administrator.                                                                                                         |
| `GET /api/feed`                     | anyone        | Visible items, newest first.                                                                                                                    |
| `GET /api/items/:id`                | anyone        | Visible item and paged alert history.                                                                                                           |
| `GET /api/alerts`                   | anyone        | Alert summaries, newest first.                                                                                                                  |
| `GET /api/alerts/:id?lang=…`        | anyone        | The alert, its document when it can be published, and delivery status.                                                                          |
| `GET /api/admin/destinations`       | administrator | Destination policy summaries, never secret references.                                                                                          |
| `PATCH /api/admin/destinations/:id` | administrator | Apply a `DestinationPatch` and write an audit entry atomically. Returns `204` or `409`.                                                         |
| `GET /api/admin/config`             | administrator | Current configuration and version, or `null`.                                                                                                   |
| `PUT /api/admin/config`             | administrator | Publish `{ expectedVersion, config }` and write an audit entry atomically. Use `0` before the first publish. Returns `409` for a stale version. |

A visible item is one in the `alerted` or `feed_only` state. A feed item's `url` is `null` when its source URL is not a public link, and a document that fails the public-link rules is served as `null` (`src/views.ts`).

Paged endpoints accept `limit` (1–100, default 25) and `before` (the previous response's opaque `next`). A full page returns a cursor even when the next page is empty. These are live keyset reads, not snapshots. Writes take JSON up to 64 KiB and reject a cross-origin `Origin` header. Destination changes have no version precondition; concurrent changes to the same policy field are last-write-wins. The API has no raw model payload, arbitrary audit details, or delivery-triggering endpoint.

Any other path that is not a static file is sent to the `ASSETS` binding. `/controls`, `/items/<id>` and `/alerts/<id>` are rewritten to `/` first, so a direct link opens the desk. An unknown `/api/` path is `404`.

### Configuration admission

`PUT /api/admin/config` returns `400 INPUT_INVALID` without changing the active version or audit log if a model route does not use `openrouter`, a timeout exceeds 2,147,483,647 ms, or a denied web domain is not a supported hostname. Denied domains must be hostnames with at least two labels, not URLs or host-and-port pairs. The pipeline checks the same rules when loading the active version and fails closed rather than falling back to an older version.

As deployed there is no administrator, so the configuration is changed through the database instead: `node tools/local/seed-sql.ts` prints the first version, the sources, and the Discord destination.

Publication does not certify the target environment. Before activation, verify the pipeline's variables, bindings, secrets, and egress configuration, and confirm that the chosen model IDs and fallbacks are available to the target provider account. The API does not load pipeline secrets, probe network services, or verify provider quotas. Admission does not make in-flight work compatible with a new config.

## Dependencies

- Hono provides Worker-compatible routing and boundary middleware absent from the platform.
- JOSE verifies signed Access tokens using the platform's Web Crypto implementation. Web Crypto alone does not enforce JOSE header, key selection, or JWT claim semantics. JOSE has no runtime dependency and avoids an app-owned security parser.
- Vite bundles the Worker, and the same tool builds the static pages in `apps/web`. `tsc` checks types, but it does not bundle dependencies or turn HTML and CSS into static assets. No UI framework or additional bundler was added.

# AI Moves API

The Worker serves the signal desk, reads feed and alert data from D1, and applies audited operator changes. It does not bind provider or notifier credentials.

## Verify locally

```sh
pnpm --filter @ai-moves/api test
pnpm --filter @ai-moves/api build
pnpm --filter @ai-moves/web build
pnpm --filter @ai-moves/api smoke:browser
```

Open the printed loopback URL. The smoke fixture serves the built Worker and web assets through Miniflare. It adds a locally signed assertion with fixture-only administrator privileges and uses a fresh, non-persistent D1 database with outbound networking denied. Stop it with Ctrl+C. The fixture is not part of the Worker build and must never be published.

## Bindings

| Name                    | Required value                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DB`                    | D1 binding with the shared storage migrations applied.                                                                                           |
| `ASSETS`                | Static assets binding for `apps/web/dist` with `run_worker_first = true`, so asset requests reach the same authentication boundary as API calls. |
| `ACCESS_ISSUER`         | The exact Access team origin, `https://<team>.cloudflareaccess.com`.                                                                             |
| `ACCESS_AUDIENCE`       | The Access application’s AUD tag.                                                                                                                |
| `ACCESS_JWKS`           | JSON containing the team’s public RSA signing `keys` from its Access certificates endpoint.                                                      |
| `ACCESS_ADMIN_SUBJECTS` | JSON array of operator Access `sub` identifiers. Omit it for no administrators.                                                                  |

The Worker verifies `Cf-Access-Jwt-Assertion` on each protected request. It pins RS256, the team issuer, and the application audience; requires a key ID, an unexpired application token, and a user subject; and honors `nbf` when present. Cookie-only and service-token identities are not accepted. Admin permission comes only from the configured subject allowlist.

Public keys are configuration, not credentials. This Worker does not fetch keys in the request path: the deployment operator must supply the current and previous Access signing keys and refresh the binding at rotation. Unknown keys and invalid configuration fail closed. Keep `workers.dev` and preview URLs disabled when configuring the deployment. No deployment is needed to run the local checks.

## Endpoints

| Method and path                     | Result                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                      | Public dependency readiness, with no configuration or binding contents.                                                                         |
| `GET /api/session`                  | Whether the verified reader can use the admin API.                                                                                              |
| `GET /api/feed`                     | Visible items, newest first.                                                                                                                    |
| `GET /api/items/:id`                | Visible item and paged alert history.                                                                                                           |
| `GET /api/alerts`                   | Alert summaries, newest first.                                                                                                                  |
| `GET /api/alerts/:id?lang=en`       | Safe alert projection, prepared document if available, and delivery status.                                                                     |
| `GET /api/admin/destinations`       | Destination policy summaries, never secret references.                                                                                          |
| `PATCH /api/admin/destinations/:id` | Apply a `DestinationPatch` and write an audit entry atomically. Returns `204` or `409`.                                                         |
| `GET /api/admin/config`             | Current configuration and version, or `null`.                                                                                                   |
| `PUT /api/admin/config`             | Publish `{ expectedVersion, config }` and write an audit entry atomically. Use `0` before the first publish. Returns `409` for a stale version. |

Paged endpoints accept `limit` (1–100, default 25) and `before` (the previous response’s opaque `next`). A full page returns a cursor even when the next page is empty. These are live keyset reads, not snapshots. Writes take JSON up to 64 KiB and reject a cross-origin `Origin` header. Destination changes have no version precondition; concurrent changes to the same policy field are last-write-wins. The API has no raw model payload, arbitrary audit details, or delivery-triggering endpoint.

## Dependencies

- Hono provides Worker-compatible routing and boundary middleware absent from the platform. Its portable request handlers are exercised in Workerd and checked by the existing TypeScript toolchain.
- JOSE verifies signed Access tokens using the platform’s Web Crypto implementation. Web Crypto alone does not enforce JOSE header, key selection, or JWT claim semantics. JOSE has no runtime dependency and avoids an app-owned security parser.
- Vite already resolves for Vitest and also bundles the Worker and static browser application. `tsc` checks types, but it does not bundle dependencies or turn HTML and CSS into static assets. No UI framework or additional bundler was added.

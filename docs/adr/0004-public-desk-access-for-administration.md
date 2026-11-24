# ADR-0004: A public desk, with Access for administration only

- **Status**: Accepted
- **Date**: 2026-11-23 (written down on 2026-11-24, after the change had shipped)

## Context

Until 2026-11-23 the desk sat behind Cloudflare Access: a reader needed a signed assertion to see the feed. The product is now a public page in Simplified Chinese at `https://moves.lineyahoo.dev` (the `prod` route in `apps/api/wrangler.jsonc`), and everything a page can show has already passed the link rules of `publicAlertDocument` in `packages/kernel/src/public-links.ts`. The owner is the only person who changes the configuration or the destinations.

## Decision

- Reads need no sign-in: `/healthz`, `/api/feed`, `/api/items/:id`, `/api/alerts` and `/api/alerts/:id` (`apps/api/src/app.ts`).
- Only `/api/admin/*` and `/api/session` verify an Access assertion (`apps/api/src/access.ts`). The check pins RS256, the team issuer, the application audience and the application token type. A caller is an administrator only when its subject is listed in `ACCESS_ADMIN_SUBJECTS`, and an admin write that carries an `Origin` header is rejected unless it is same-origin (`apps/api/src/app.ts`).
- The verifier fails closed. Unless `ACCESS_ISSUER`, `ACCESS_AUDIENCE` and `ACCESS_JWKS` are all present and well formed, it rejects every identity: the admin routes answer `401 UNAUTHENTICATED` and `/api/session` answers `{"admin":false}`. `ACCESS_ADMIN_SUBJECTS` defaults to no administrator.
- Neither environment declares an `ACCESS_*` variable (`apps/api/wrangler.jsonc`), so a deployed desk has no administrator.
- The admin view stays in `apps/web`: the `/controls` page and its two forms (`apps/web/src/admin.ts`). Its link is shown only when `/api/session` reports an administrator (`apps/web/src/main.ts`), so as deployed it cannot be reached.

## Alternatives

- Keep Access in front of the whole desk. Every reader would need an account on the owner's team, which a public page cannot ask for.
- Delete the admin API and the view. Nothing could then change the configuration or a destination without a database session. They were left in place; whether to remove them is an open question.
- A second Worker for administration. That is one more deployment unit to serve one operator.

## Consequences

- The desk's address is public and its reads are unauthenticated. Nothing served by a read may be private.
- With no `ACCESS_*` variable set, the configuration and the destinations change only through the database. `tools/local/seed-sql.ts` prints the rows a fresh deployment needs.
- An environment gets an administrator by configuration: set the three bindings and the subject list, then deploy. That is a credential change, which `AGENTS.md` lists under "ask first".
- The `ASSETS` binding serves the built desk from `apps/web/dist` (`apps/api/wrangler.jsonc`). The Worker handles the requests it does not answer and rewrites `/controls`, `/items/<id>` and `/alerts/<id>` to `/`, so a direct link opens the desk (`apps/api/src/app.ts`).
- The desk calls `/api/session` on every page load to decide whether to show the link to the controls (`apps/web/src/main.ts`).

## Review Triggers

Revisit this decision when an `ACCESS_*` set is configured for an environment, when the admin API or the view is removed or moved to its own deployment unit, or when a read has to serve something that is not a published document.

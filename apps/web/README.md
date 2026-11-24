# AI Moves Desk

The public reading desk: a feed of published items, one article per item, and the alert pages behind them. It is plain TypeScript built by Vite into static assets, which the [desk Worker](../api/README.md) serves from the same origin as the read API.

```sh
pnpm --filter @ai-moves/web build
```

| Path          | Page                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `/`           | Feed of published items, newest first; `?before=` pages back         |
| `/items/:id`  | The item's article, read from its newest alert                       |
| `/alerts/:id` | One alert's document; `?lang=` selects a language when several exist |
| `/controls`   | Deprecated admin page; see below                                     |

- Public pages never call `/api/session` and need no sign-in; only `/controls` asks who the reader is.
- All requests are same-origin `fetch` calls to the read API, with no browser-held tokens. Responses are validated against the shared contract schemas before rendering.
- Security headers for static assets come from `public/_headers`, which must stay in step with the API middleware in `apps/api/src/app.ts`.

**Language**: on `main`, the page shell and reader-facing messages are hardcoded Simplified Chinese (`index.html`, `src/main.ts`, `src/api.ts`, `src/feed.ts`), the default document language is `zh-CN`, and the `/controls` copy is English. Moving this text into locale packs with an `en` default is scheduled; see [ARCHITECTURE.md](../../ARCHITECTURE.md#language-policy-and-locale-seam).

**Deprecated**: `/controls` (`src/admin.ts`) edits destinations and publishes configuration through the Access-protected admin API. The product has no login and no admin UI, so the page and its API are scheduled for removal.

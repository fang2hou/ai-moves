# AI Moves Desk

The public reading desk: a feed of published items, one article per item, and the alert pages behind them. It is plain TypeScript built by Vite into static assets, which the [desk Worker](../api/README.md) serves from the same origin as the read API.

```sh
pnpm --filter @ai-moves/web build
```

| Path          | Page                                                         |
| ------------- | ------------------------------------------------------------ |
| `/`           | Feed of published items, newest first; `?before=` pages back |
| `/items/:id`  | The newest article or a link to the public source            |
| `/alerts/:id` | One alert's document                                         |
| `/controls`   | Deprecated admin page; see below                             |

- Public pages never call `/api/session` and need no sign-in; only `/controls` asks who the reader is.
- All requests are same-origin `fetch` calls to the read API, with no browser-held tokens. Responses are validated against the shared contract schemas before rendering.
- Security headers for static assets come from `public/_headers`, which must stay in step with the API middleware in `apps/api/src/app.ts`.

The desk defaults to English. Set `VITE_LOCALE=zh-CN` or `VITE_LOCALE=ja` when building to localize the static shell and Open Graph metadata. Deployment builds use `DESK_LOCALE`, with `zh-CN` as the workflow default. Add `?lang=en|zh-CN|ja` to browse in another supported locale. Desk links carry the override through navigation, and article requests use it as the preferred document language. The deprecated controls form uses English labels.

**Deprecated**: `/controls` (`src/admin.ts`) edits destinations and publishes configuration through the Access-protected admin API. The product has no login and no admin UI, so the page and its API are scheduled for removal.

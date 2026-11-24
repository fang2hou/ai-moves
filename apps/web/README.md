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

- The desk is read-only and public. The former controls page and sign-in flow have been removed.
- All requests are same-origin `fetch` calls to the read API, with no browser-held tokens. Responses are validated against the shared contract schemas before rendering.
- Security headers for static assets come from `public/_headers`, which must stay in step with the API middleware in `apps/api/src/app.ts`.

Set `VITE_LOCALE` to `en`, `zh-CN`, or `ja` when building. It sets the static shell, Open Graph metadata, default runtime UI locale, and preferred document language. Unset or empty values select English. An unsupported value fails the build. Deployment and preview builds use `DESK_LOCALE`, with `zh-CN` as the workflow default. Add `?lang=en|zh-CN|ja` to browse in another supported locale. Desk links carry the override through navigation, and article requests use it as the preferred document language.

The **Desk PR Preview** workflow builds these assets for same-repository pull requests and links to the public preview in its job summary. The preview API reads the dev D1 database. See [Development](../../DEVELOPMENT.md#desk-pull-request-previews).

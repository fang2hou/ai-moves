# AI Moves desk

The public desk: a feed of the newest items, one page per item, and one page per alert. It is written in Simplified Chinese and built with Vite. The [API Worker](../api/README.md) serves the result as static assets.

```sh
pnpm --filter @ai-moves/web build
```

The build writes `apps/web/dist`, which `apps/api/wrangler.jsonc` binds as `ASSETS`. CI runs the same build.

## Pages

| Path           | What it shows                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`            | The feed, newest first, with a link to older items.                                                                                                |
| `/items/<id>`  | The item's article: the document of its newest alert. A Hacker News story has one living article, and the newest alert carries the latest reading. |
| `/alerts/<id>` | One alert and its document.                                                                                                                        |
| `/controls`    | The admin view, with the destinations and the published configuration. It renders only for an administrator.                                       |

## How it works

- `src/main.ts` picks the page from the path and calls the same-origin API through `src/api.ts`. There are no browser-managed tokens and no framework: the views are built with `document.createElement` (`src/dom.ts`).
- Every response is checked against a zod schema before anything is shown (`src/api.ts`).
- On every load the page asks `/api/session`, and the link to the controls is shown only when it reports an administrator. Neither deployed environment has one, so `/controls` shows "你没有访问控制台的权限。" there. The admin view in `src/admin.ts` is still built and shipped.
- An item shows a mark for where it came from (`src/source.ts`). Hacker News has its own; a repository has a mark of its own or, without one, its owner's avatar, which is the one remote image the desk loads; a documentation site has a mark served from `public/marks` or a monogram of its name.
- `?lang=<lang>` selects the language of a document. The desk asks for Simplified Chinese when the parameter is missing or unknown, and the API serves whichever language exists.

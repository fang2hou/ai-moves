# AI Moves Desk

The public reading desk: a feed of published items, one article per item, and the alert pages behind them. It is plain TypeScript built by Vite into static assets, which the [desk Worker](../api/README.md) serves from the same origin as the read API.

```sh
mise run build-web
```

| Path          | Page                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `/`           | Feed of published items, newest first; `?before=` pages back                                              |
| `/items/:id`  | The newest article or a link to the public source                                                         |
| `/alerts/:id` | One alert's document                                                                                      |
| `/heat`       | Heat over the last 7 or 30 days (`?days=7`): counts per day and source, and the most-voted HN discussions |

- `/submissions` exists only when the build sets `VITE_MCP_PATH`; see [Submissions page](#submissions-page).
- A submitted item (📮 mark, named by the host of its source URL) shows `Submitted by <name>` under the origin line on its article. The heat page counts submissions as a third series in the stats, the daily chart, and the source ranking.
- The desk is read-only and public. The former controls page and sign-in flow have been removed.
- All requests are same-origin `fetch` calls to the read API, with no browser-held tokens. Responses are validated against the shared contract schemas before rendering.
- Security headers for static assets come from `public/_headers`, which must stay in step with the API middleware in `apps/api/src/app.ts`.

Set `VITE_LOCALE` to `en`, `zh-CN`, or `ja` when building. It sets the static shell, Open Graph metadata, default runtime UI locale, and preferred document language. Unset or empty values select English. An unsupported value fails the build. Deployment and preview builds use `DESK_LOCALE`, with `zh-CN` as the workflow default. Add `?lang=en|zh-CN|ja` to browse in another supported locale. Desk links carry the override through navigation, and article requests use it as the preferred document language.

Set `VITE_SITE_NAME` to give a deployment its own desk name. It replaces the locale pack's `siteName` in the shell, the page titles, and the Open Graph metadata, in every locale. Unset or blank values keep the pack's name.

## Submissions page

Set `VITE_MCP_PATH` to the same-origin path of the deployment's MCP endpoint (for example `/api/mcp`) to add a `Submissions` masthead link and the `/submissions` page. Unset or blank, the link is hidden and the route shows the not-found notice, as on the upstream desk.

The page lists the submissions in the order `list_submissions` returns them, one row each:

- a folded "what the AI reviewer looks for" panel above the list (`criteria` in the locale pack), which mirrors the review prompt's topics and score bands so a submitter can check them;
- the title (a link to the published article, or to the source URL before publication) and a state badge: in review, rejected, published, sent, failed, or forced;
- the source name or host, the submitter's display name, the submitted date, and `forced by` when someone forced the item;
- the reviewer's verdict: the score as a large number with a pass or reject tag, and the reviewer's one-line comment under it (a legacy triage reason shows as a comment with no score; a submission not yet reviewed says so);
- the alert outcome once deep analysis finished: sent, or not sent with the blocked reasons in words;
- a review-again button when the row's `can_rereview` is set (a rejected item). It asks for confirmation, then sends the item through the current reviewer again, and the row is replaced by the summary the call returns.
- a force-publish button when the row's `can_force` is set. It asks for confirmation, then sends the item straight to deep analysis and sending, and the row is replaced by the summary the call returns.

The page calls the MCP endpoint with JSON-RPC `tools/call` (`list_submissions`, and `force_publish` or `rereview_submission` with `{ "item_id": … }`) through a same-origin `fetch` with credentials. Each POST carries `x-amz-content-sha256`, the hex SHA-256 of the exact body, because CloudFront's origin access control rejects a POST without it. Results are read from `result.structuredContent` and validated with `SubmissionListSchema` and `SubmissionSummarySchema`. A 401 or a reply that is not JSON shows a sign-in notice; the submitter's email is never part of the wire format.

The **Desk PR Preview** workflow builds these assets for same-repository pull requests and links to the public preview in its job summary. The preview API reads the dev D1 database. See [Development](../../DEVELOPMENT.md#desk-pull-request-previews).

# Delivery

Plans, executes, and recovers outbound alert deliveries. Everything here runs only when the published configuration sets `delivery.feed_only: false`; see [Publication and the feed-only switch](#publication-and-the-feed-only-switch).

| Import                                 | Function                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ai-moves/delivery/finalize`          | `planDeliveries` picks enabled, eligible destinations with a document in their language (an `en` destination gets none while `output_lang` is not `en`); `finalizeAlert` stores the alert, documents, and deliveries atomically |
| `@ai-moves/delivery/execute`           | `executeDelivery` applies destination and timing policy, claims a live send, and calls the notifier                                                                                                                             |
| `@ai-moves/delivery/recovery`          | `recoverExpiredSend` fences an expired `sending` lease to `unknown`                                                                                                                                                             |
| `@ai-moves/delivery/notifiers/webhook` | `createWebhookNotifier` for Discord and Slack incoming webhooks                                                                                                                                                                 |
| `@ai-moves/delivery/render/discord`    | `renderDiscord`: one embed per alert                                                                                                                                                                                            |
| `@ai-moves/delivery/render/slack`      | `renderSlack`: one Block Kit message per alert (see below)                                                                                                                                                                      |

## Publication and the feed-only switch

Finalization stores the alert and its language documents atomically. With `delivery.feed_only: true` (the schema default), a `send` decision is recorded as `feed_only` and no delivery rows are created; the `q-deliver` consumer suppresses legacy jobs. With `feed_only: false`, deliveries are planned for enabled destinations and executed through the webhook notifier. The seed SQL printed by `tools/local/seed-sql.ts` sets `feed_only: false` with `profile.output_lang: zh-CN` and a matching Discord destination; it is applied by hand when a database is first initialized, not by the deploy workflow.

## Sending

The push thresholds and delivery policy govern notifications. Publish `delivery.paused: true` to suppress attempted sends with `global_pause` while the desk continues to publish. Suppressions are terminal.

- The webhook URL is a secret named by the destination's `secret_ref`, and must be HTTPS on `discord.com` or `hooks.slack.com`. Each call makes one request with `redirect: "manual"`. Discord adds `wait=true`, and a 2xx counts as sent only when its receipt is at most 64 KiB of JSON carrying a message `id`; Slack discards the body of any 2xx and records no message ID.
- A 5xx is an answer that the message was not taken: `UPSTREAM_UNAVAILABLE`, retryable. A 429 is `UPSTREAM_RATE_LIMITED`, retryable. Any other non-success, including a redirect, is `UPSTREAM_REJECTED`, permanent.
- No response, a Discord receipt that is oversized or lacks an `id`, or no answer within `timeouts.notifier_ms` (default 10 s, applied in `executeDelivery`) is `OUTCOME_UNKNOWN`: the delivery becomes `unknown` and is never resent, because the message may have arrived.
- Retryable failures move to `failed_retryable` and back off per `retry.deliver` (5 attempts by default); the last one becomes `failed_permanent` with `ATTEMPTS_EXHAUSTED`.

## Discord cards

A Discord delivery requires a `send` decision with no blocking reason and a stored document that belongs to the alert, matches the destination's language without an English fallback, and passes the public-link rules; otherwise the delivery is suppressed before any claim or secret lookup. The card has a title linking to the desk article, the summary, key points grouped by category (breaking, new, change, fix) with their implications as subtext, and the source link as the last field. Points that carry an evidence quote are left out, markup and mentions are escaped, and every length is bounded to Discord's embed limits.

A submission card has its own violet accent, no product mark, and a footer naming the submitter (`submittedByLabel`) in place of the repeated source label. Before a Discord send, the document's `submitted_by` must equal the display name recorded on the item's `score_json`; the email never reaches a card.

Discord selects [locale pack](../locales/README.md) labels from the document language. `node tools/local/card-json.ts` prints a card for a stored document without sending it.

## Slack

`renderSlack` returns `{ text, blocks }` for an incoming webhook, under the same suppression rules as a Discord card. Labels come from the same [locale pack](../locales/README.md) entries as Discord (`groupLabels`, `pointsLabel`, `readingLabel`) plus the button labels.

| Block                   | Content                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `header`                | The title as `plain_text`, code marks removed, clipped to 150 characters with an ellipsis                                                                                                                                                                                           |
| `context`               | A kind mark (📦 release, 🔥 discussion, 📮 submission), the source label, and for a submission `Submitted by: <name>` (the `submittedByLabel` copy), as `plain_text`                                                                                                                |
| `rich_text`             | The summary, unless it repeats the title                                                                                                                                                                                                                                            |
| `divider`               | Before and after the points, when there are points                                                                                                                                                                                                                                  |
| `section` + `rich_text` | Per point group (breaking, new, change, fix), or one points list for a discussion: the bold label as an escaped `mrkdwn` section, whose padding separates the groups, over a bullet list; each reading is a quote right under its point, opening with 💡 and the bold reading label |
| `actions`               | Link buttons with emoji: the desk article (primary), the source, and the Hacker News discussion when there is one                                                                                                                                                                   |

- The top-level `text` is a short fallback for notifications: the source label and the title, escaped, unlinked, and without code marks.
- Only locale copy (group labels) is written as `mrkdwn`; model text goes into `rich_text` blocks, which Slack never parses: `@here`, `<!channel>`, `*`, and stray backticks stay literal, and nothing needs escaping. A balanced backtick pair becomes a piece styled as code, so inline code renders the same next to Japanese or Chinese text as next to spaces, and copies without hidden characters. Addresses in model text are broken so Slack does not link them; every link is a button URL that passed the public-link rules.
- Points that carry an evidence quote are left out, so neither a quote nor a comment ID ever reaches Slack.
- Lengths stay within Block Kit limits: 150 characters per header, 3,000 per rich text block and context element, 75 per button label, 3,000 per URL. The layout has at most sixteen blocks, under the limit of 50.
- An invalid desk link or an empty title throws `CONTENT_UNSUPPORTED`, as for Discord.

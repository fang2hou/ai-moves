# Delivery

Plans, executes, and recovers outbound alert deliveries. Everything here runs only when the published configuration sets `delivery.feed_only: false`; with the default `true`, the pipeline records alerts as `feed_only` and suppresses legacy delivery jobs instead.

| Import                                 | Function                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ai-moves/delivery/finalize`          | `planDeliveries` picks enabled, eligible destinations with a document in their language (an `en` destination gets none while `output_lang` is not `en`); `finalizeAlert` stores the alert, documents, and deliveries atomically |
| `@ai-moves/delivery/execute`           | `executeDelivery` applies destination, time, and budget policy, claims a live send, and calls the notifier                                                                                                                      |
| `@ai-moves/delivery/recovery`          | `recoverExpiredSend` fences an expired `sending` lease to `unknown`                                                                                                                                                             |
| `@ai-moves/delivery/notifiers/webhook` | `createWebhookNotifier` for Discord and Slack incoming webhooks                                                                                                                                                                 |
| `@ai-moves/delivery/render/discord`    | `renderDiscord`: one embed per alert                                                                                                                                                                                            |
| `@ai-moves/delivery/render/slack`      | `renderSlack`: plain-text stub (see below)                                                                                                                                                                                      |

## Sending

- The webhook URL is a secret named by the destination's `secret_ref`, and must be HTTPS on `discord.com` or `hooks.slack.com`. Each call makes one request with `redirect: "manual"`. Discord adds `wait=true`, and a 2xx counts as sent only when its receipt is at most 64 KiB of JSON carrying a message `id`; Slack discards the body of any 2xx and records no message ID.
- A 5xx is an answer that the message was not taken: `UPSTREAM_UNAVAILABLE`, retryable. A 429 is `UPSTREAM_RATE_LIMITED`, retryable. Any other non-success, including a redirect, is `UPSTREAM_REJECTED`, permanent.
- No response, a Discord receipt that is oversized or lacks an `id`, or no answer within `timeouts.notifier_ms` (default 10 s, applied in `executeDelivery`) is `OUTCOME_UNKNOWN`: the delivery becomes `unknown` and is never resent, because the message may have arrived.
- Retryable failures move to `failed_retryable` and back off per `retry.deliver` (5 attempts by default); the last one becomes `failed_permanent` with `ATTEMPTS_EXHAUSTED`. Budgets are debited per destination and per source kind before the request.

## Discord cards

A Discord delivery requires a `send` decision with no blocking reason and a stored document that belongs to the alert, matches the destination's language without an English fallback, and passes the public-link rules; otherwise the delivery is suppressed before any claim, debit, or secret lookup. The card has a title linking to the desk article, the summary, key points grouped by category (breaking, new, change, fix) with their implications as subtext, and the source link as the last field. Points that carry an evidence quote are left out, markup and mentions are escaped, and every length is bounded to Discord's embed limits.

Labels come from per-language maps inside `src/render/discord.ts`; moving them into shared locale packs is scheduled (see [ARCHITECTURE.md](../../ARCHITECTURE.md#language-policy-and-locale-seam)). `node tools/local/card-json.ts` prints a card for a stored document without sending it.

## Slack

`renderSlack` is an 11-line plain-text stub over `src/render/text.ts`, which prints English-only labels and raw `evidence_quote` lines. It must be replaced by a Block Kit renderer that shares the locale packs before the Phase 2 Slack rollout.

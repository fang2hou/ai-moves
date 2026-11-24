# Delivery

`planDeliveries` selects enabled, eligible destinations for a `send` decision and creates stable destination idempotency keys. `finalizeAlert` persists the alert, its documents, and the delivery rows atomically through the storage port, then publishes the pending delivery IDs. Replays publish only canonical pending delivery IDs; the durable delivery sweep recovers a partial queue publication.

`executeDelivery` applies the destination and time policy, reserves live sends atomically, and debits destination and source budgets for each won attempt. Failed attempts use persisted bounded backoff; ambiguous outcomes are terminal. `recoverExpiredSend` fences an expired sending lease and marks it unknown. Composition must provide the current validated configuration and invoke this recovery for stale sending rows.

The pipeline sends only when the published configuration has `delivery.feed_only` set to false ([ADR-0005](../../docs/adr/0005-live-discord-delivery.md)). `apps/pipeline/src/worker.ts` wires the consumer and the webhook notifiers. With the switch on, the consumer fences pending rows as `suppressed` with the reason `rollout_feed_only`.

## Notifiers

`createWebhookNotifier` in `src/notifiers/webhook.ts` serves both channels with injected secrets and HTTP transports, and makes one request per call. The secret named by a destination's `secret_ref` has to be an HTTPS webhook URL on `hooks.slack.com` or `discord.com`. A transport failure, HTTP 5xx, or unreadable Discord confirmation produces a terminal `unknown` outcome; queue replay does not resend or release the live-send reservation. Explicit HTTP 429 throttling remains retryable, and other non-success responses remain permanent rejections. Discord requests confirmation with `wait=true` and reads at most 64 KiB of decoded response bytes before parsing the receipt. Slack success and HTTP error bodies are discarded.

Slack is dormant. `src/render/slack.ts` renders plain text, but no deployment declares a Slack destination or a secret a Slack destination could name.

## Discord cards

`renderDiscord` in `src/render/discord.ts` builds one embed:

- The title is the reading's headline and links to the item's page on the desk.
- The description is the summary. The points follow as fields. A changelog is grouped into breaking, new, changed and fixed, and each point is followed by its reading as a subtext line. A discussion keeps one list. A point that carries an evidence quote is left out: a card prints the reading, not the evidence.
- The source link is the last field.
- The author is the source label, with the product's mark as its icon. The color says what kind of card it is, green for a release and orange for a discussion. Both are chosen by the program from the source URL, never from model output (`src/render/brand.ts`).

Free text is escaped and bounded, so a stray markup character cannot open a code fence, and all mentions are disabled. The labels are written in the document's language. See Discord's [Execute Webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook) and [Embed Limits](https://docs.discord.com/developers/resources/message#embed-limits).

Before a Discord delivery is claimed, `executeDelivery` checks the alert and the document. An alert that is not a `send` decision, or that carries a block reason, is suppressed with that reason. The stored document has to belong to this alert, item and destination language, pass the public-link rules, and link to the observed source; the canonical discussion stands in for the source of a Hacker News text post. Anything else is suppressed as `unverified_content` before a claim, a budget debit, or a secret lookup. The existing expiry, deduplication, rate limit, and budget policies still apply.

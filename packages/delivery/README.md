# Delivery

`planDeliveries` selects enabled, eligible destinations with a validated language document and
creates stable destination idempotency keys. `finalizeAlert` persists the alert, language
documents, and delivery rows atomically through the storage port. Replays publish only canonical
pending delivery IDs; the durable delivery sweep recovers a partial queue publication.

`executeDelivery` applies the destination and time policy, reserves live sends atomically, and
debits destination and source budgets for each won attempt. Failed attempts use persisted bounded
backoff; ambiguous outcomes are terminal. `recoverExpiredSend` fences an expired sending lease
and marks it unknown. Composition must provide the current validated configuration and invoke this
recovery for stale sending rows.

The Slack and Discord webhook notifiers accept injected secrets and HTTP transports. They make one
request per call. A transport failure, HTTP 5xx, or unreadable Discord confirmation produces a
terminal `unknown` outcome; queue replay does not resend or release the live-send reservation.
Explicit HTTP 429 throttling remains retryable, and other non-success responses remain permanent
rejections. Discord requests confirmation with `wait=true` and reads at most 64 KiB of decoded
response bytes before parsing the receipt. Slack success and HTTP error bodies are discarded.

## Discord alerts

The delivery engine requires an existing `send` decision and a current program-owned
score before claiming Discord work: HN heat must meet the existing push heat floor and
support the stored tier, and changelog prior must meet the existing push prior floor.
The current destination must be an enabled alert destination whose source, tier, and language
match. The stored document must match the item and alert, carry a citation quote, and link
to the observed source (the canonical discussion for an HN text post). Non-English
destinations require a validated translation; there is no English fallback. Unsupported
documents are suppressed as `unverified_content` before a claim, budget debit or secret lookup.
The existing expiry, deduplication, rate limit, and budget policies still apply.

Discord sends one embed with a clickable source headline, why it matters, up to one
engineering implication for a changelog, a source quote, and the source label. The quote is
shown as recorded, not as a translated claim. Missing or repeated text is omitted,
free text is escaped and bounded, and all mentions are disabled. See Discord's
[Execute Webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook)
and [Embed Limits](https://docs.discord.com/developers/resources/message#embed-limits).

This path is exercised locally through `pnpm --filter @ai-moves/delivery test test/notifier.test.ts`.
The test captures the webhook JSON and persistence outcomes through injected ports.
The deployed Worker remains [feed-only](../../docs/adr/0003-initial-feed-only-rollout.md);
it does not use this path or provide a configuration switch to enable it.

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
Discord disables mentions and shortens long messages with a link to the full detail.

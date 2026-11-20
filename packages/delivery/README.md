# Delivery

`finalizeAlert` persists the alert, language documents, and delivery rows atomically through the
storage port. Replays publish only canonical pending delivery IDs; the durable delivery sweep
recovers a partial queue publication.

`executeDelivery` applies the destination and time policy, reserves live sends atomically, and
debits destination and source budgets for each won attempt. Failed attempts use persisted bounded
backoff; ambiguous outcomes are terminal. `recoverExpiredSend` fences an expired sending lease
and marks it unknown. Composition must provide the current validated configuration and invoke this
recovery for stale sending rows.

The Slack and Discord webhook notifiers accept injected secrets and HTTP transports. They make one
request per call; a transport failure or unparseable Discord success is an unknown outcome.
Discord requests confirmation with `wait=true` and disables mentions. Long Discord messages are
shortened with a link to the full detail.

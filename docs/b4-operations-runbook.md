# Pipeline operations runbook

Use this guide to diagnose the pipeline locally. Production procedures and the
checks required before a first deployment are listed separately below.

## Reproduce locally

From the repository root, with the pinned tools and dependencies installed:

```bash
pnpm --filter @ai-moves/ingestion test
pnpm --filter @ai-moves/pipeline test test/pipeline.test.ts
pnpm --filter @ai-moves/pipeline test test/delivery-replay.test.ts
```

The pipeline suites use fresh local D1 and R2 bindings and scripted transports.
Do not connect these scenarios to a real provider, webhook, remote database, or
queue. See [Development](../DEVELOPMENT.md#local-pipeline) for setup.

## Read the signals

The default Worker emits JSON log lines and metric samples to the console. Metric
names and dimensions use finite categories; trace, source and item IDs are log
correlation fields, never metric dimensions. Error events log the classified code
and kind, not the original exception message or stack. Do not add message bodies,
prompts, citations, URLs, credentials or provider responses to diagnostics.

- `pipeline.queue.age_ms`: time from the platform message timestamp to the
  start of handling that message, by queue. Missing, invalid and future
  timestamps are excluded. This includes time waiting behind earlier messages
  in the same batch; it does not measure age of durable work.
- `pipeline.queue.disposition` and `pipeline.job.duration_ms`: calls to ack or
  retry, by queue; elapsed handler time for decoded jobs, by stage and
  disposition. An ack can mean no work was claimed and is not proof of a
  product outcome. Failed decoding emits no stage-duration sample.
- `pipeline.poll.result`: poll result, including a claim not acquired or lost
  and a persisted backoff. `pipeline.poll_backoff` includes the classified code;
  a backoff can still be acked.
- `pipeline.dispatch.ready` and `pipeline.dispatch.published`: ready poll slots
  selected, and jobs passed to batches that all returned successfully. A
  rejected publication may have accepted some jobs before failing.
- `pipeline.sweep.selected` and `pipeline.sweep.recovery`: rows selected by
  each bounded query, and committed recovery or a lost fence, by prior state.
  These are not backlog totals or audit records.
- `pipeline.sweep.published` and `pipeline.sweep.snapshots_deleted`: jobs from a
  sweep whose batches all returned successfully, and the actual number of old
  snapshots deleted. Publication success is not consumption.
- `pipeline.budget.decision`: responses from durable debit requests, by coarse
  scope, job stage and decision. The log records that response's ledger `used`
  and `limit`; neither is an additive metric. Replayed receipts can emit
  another decision, and some policy paths skip the debit call.
- `pipeline.delivery.transition`: committed delivery transitions observed by
  the delivery consumer, by resulting state. Sweep transitions to `unknown` are
  counted under `pipeline.sweep.recovery` instead. `sent` includes simulated
  delivery; use persisted delivery and configuration history to assess the
  actual mode, not this counter.

`pipeline.message_acknowledged` and `pipeline.message_failed` carry the
platform attempt when it is present. `pipeline.item_transition`,
`pipeline.analysis_completed` and `pipeline.delivery_transition` report
committed state; item and delivery transitions can carry persisted attempt
counts, which are independent of queue attempts. Analysis completions are
tagged by parent job: a `deep` job can complete deep analysis and translations.
The Worker does not measure per-translation latency or retry causes consumed
inside analysis. Analysis budgets limit logical model calls, not individual
provider requests: repair and fallback may issue additional calls.

Console samples are best-effort observations, not a configured metrics backend.
No aggregation, retention, dashboards, alarms, queue depth, or DLQ depth is
implemented by these signals. Use persisted state to settle disagreements.

## Diagnose stalled work

1. Check binding and configuration readiness without creating a job. Confirm an
   active published configuration and usable D1, R2 and queue bindings. A bad
   invocation envelope or unusable configuration may reject before per-job
   telemetry; no separate pipeline readiness endpoint is provided.
2. Check `pipeline.dispatch_failed` and `pipeline.sweep_failed` separately. The
   cron runs both branches independently, and reports both if both fail. Failed
   batches carry no exact accepted count. Retry of the scheduled handler or a
   later tick can rediscover ready work without hand-editing a queue.
3. Read persisted work through approved read-only tooling. For polling, check
   the existing slot's bucket and lease, then the source's `next_poll_at` and
   failure count. For items and deliveries, inspect `state`, `state_updated_at`,
   `attempts` and `next_attempt_at`. A future retry time or live lease is not
   stuck. Check the active lease settings before interpreting old rows.
4. Compare with the next bounded sweep. Each query selects at most 100 rows;
   observing 100 means the query hit its cap, not that the total backlog is 100.
   Ready `candidate`, `triaged_pass` and `analyzed` rows must be older than one
   poll bucket to be republished. Expired `triaging` and `analyzing` rows must
   also be due before the sweep can restore their ready states. Fenced transitions
   did not win and are not counted as recoveries. The consumer, not the sweep,
   enforces exhaustion and checks for reusable completed analysis.
5. Escalate repeated capped selections without progress, persistent branch
   failures, or aged ready rows that survive successive successful ticks. Give
   the owning operator the time range, classified errors, affected states,
   safe correlation IDs and configuration version when known. Do not manually
   edit queues, resubmit uncertain messages, or mutate rows to clear an alert.

## Treat `unknown` delivery as unresolved

An expired `sending` lease is fenced to `unknown` with `OUTCOME_UNKNOWN`; the
sweep does not enqueue it. A notifier can also produce an ambiguous outcome
before lease expiry. Neither proves that a send did or did not happen: a lease
only fences writes and cannot cancel a request already sent.

Do not resend an `unknown` delivery, reset it to `pending`, release its
reservation, or refund its debit. Escalate to the delivery owner for
reconciliation using authorized read-only evidence. Any later remediation
requires an approved operational action and evidence that it will not duplicate
a send; this runbook does not authorize it.

## Required before production

- Confirm egress bindings and review network enforcement. `PROVIDER_HTTP` must
  preserve redirect handling without logging credentials; `PINNED_WEB` must
  connect to the resolved address without a second lookup and preserve the
  request host for TLS and HTTP. Never fall back to a normal hostname fetch.
- Configure finite platform retries and a DLQ for each queue, with named owners,
  access, alerts, triage and a reviewed replay policy. The pipeline does not
  consume DLQs. Local assertions do not establish platform redelivery,
  concurrency, isolation or service limits.
- Review a configuration and prompt drain or migration plan and rollback before
  changing versions with work pending. A pending analysis can retain an older
  configuration version while a retry uses active settings. Version isolation
  for incompatible rollouts is not established.
- Confirm the account, destinations, model identifiers, budgets and licenses
  with their owners. Creating resources, writing credentials, migration,
  deployment and enabling outbound sends require explicit human authorization
  at the point of operation.

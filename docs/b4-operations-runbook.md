# Pipeline operations runbook

Use this guide to run, observe, and diagnose the deployed pipeline (`dev` and `prod`) and its local equivalent. Architecture and invariants are in [ARCHITECTURE.md](../ARCHITECTURE.md); deployment mechanics are in [DEVELOPMENT.md](../DEVELOPMENT.md#deployment).

## Environments and queue settings

| Setting     | `dev`                                    | `prod`                             |
| ----------- | ---------------------------------------- | ---------------------------------- |
| Deployed by | Push to `main`                           | Published GitHub Release           |
| Schedule    | None; start a run with `POST /trigger`   | `*/5 * * * *` (every 5 minutes)    |
| Desk        | `ai-moves-desk-dev.fang2hou.workers.dev` | `moves.lineyahoo.dev`              |
| D1 / R2     | `ai-moves-dev` / `ai-moves-blobs-dev`    | `ai-moves` / `ai-moves-blobs`      |
| `q-poll`    | batch 10, concurrency 1, retries 3       | batch 10, concurrency 2, retries 3 |
| `q-triage`  | batch 10, concurrency 1, retries 3       | batch 10, concurrency 2, retries 3 |
| `q-deep`    | batch 1, concurrency 1, retries 3        | batch 1, concurrency 2, retries 3  |
| `q-deliver` | batch 10, concurrency 1, retries 3       | batch 10, concurrency 1, retries 3 |

The source of truth is `apps/pipeline/wrangler.jsonc`. `q-deep` takes one message per batch because one deep job can make several model calls of up to 180 seconds each, so the platform's consumer time limit bounds one job instead of ten. No dead-letter queue is configured: D1, not the queue, is authoritative, and the sweep rediscovers ready work after a message is lost.

## Pause AI or notifications

There are no daily AI or delivery budgets. HN gates, changelog prior scores, and push thresholds govern qualification. The repository defaults and fresh database seed use the [calibrated HN thresholds](../packages/core/README.md#hacker-news-scoring).

Publish a new version of the active configuration with the switch you need. Events already executing can finish using the configuration they started with.

- Set `ai.enabled: false` to pause triage and deep consumers. Source polling continues and ready items stay eligible for the sweep. Set `ai.enabled: true` to resume analysis.
- Set `delivery.paused: true` to stop notifications while continuing to publish on the desk. The send policy records `global_pause` when it processes a paused delivery. Set `delivery.paused: false` to allow future eligible sends. Terminal suppressions stay suppressed.

## Desk pull request previews

Open the **Desk PR Preview** workflow summary on a same-repository pull request to find its aliased URL. It serves the read-only Desk and uses the shared `ai-moves-dev` D1 database (`5bcc51a7-b879-4a33-ab9a-7a473041125b`). Preview uploads exclude production resources, the pipeline, and migrations.

- If the summary reports missing credentials, check the GitHub `preview` environment for `CLOUDFLARE_PREVIEW_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Give the dedicated preview token only the Workers permissions required to upload Desk preview versions and assets. Keep deployment credentials in their respective environments.
- If Wrangler uploads a version without an alias URL, check that Version URLs are enabled on `ai-moves-desk-dev`. Cloudflare retains aliases only while their versions are retained.
- Check `GET /healthz` for database reachability and `GET /api/feed` for published dev data. The Desk has no administration endpoints.

## Reproduce locally

- Start a `dev` run without waiting for a schedule: send `POST /trigger` to the `dev` pipeline Worker with header `x-trigger-token: <TRIGGER_TOKEN>`. It runs exactly what the cron runs and answers `{"ran":"scheduled","at":...}`; without a configured token of at least 16 characters, every request gets 404.
- Run the whole pipeline locally with `tools/local/run.ts` (see [tools/local/README.md](../tools/local/README.md)). It calls the live model provider, so run it only when asked.
- Render a stored document as a Discord payload without sending it: `node tools/local/card-json.ts [item id or title fragment]` (reads the `dev` desk's public API unless `DESK_URL` is set; no model call).

## Read the signals

The Worker emits JSON log lines and metric samples to the console, which Workers observability collects. Metric names and dimensions use finite categories; trace, source, and item IDs are log correlation fields, never metric dimensions. Error events log the classified code and kind, not the original exception message or stack. Do not add message bodies, prompts, citations, URLs, credentials, or provider responses to diagnostics.

- `pipeline.queue.age_ms`: time from the platform message timestamp to the start of handling, by queue. Missing, invalid, and future timestamps are excluded.
- `pipeline.queue.disposition` and `pipeline.job.duration_ms`: ack or retry per message, by queue; handler time for decoded jobs, by stage and disposition. An ack can mean no work was claimed.
- `pipeline.dispatch.ready` and `pipeline.dispatch.published`: ready poll slots selected, and jobs passed to batches that all returned successfully.
- `pipeline.poll.result`: poll outcome, including a claim not acquired or lost and a persisted backoff. `pipeline.poll_backoff` logs the classified code.
- `pipeline.poll.unsplit`: a web changelog page changed but no followed release could be split from it, by source label. Nothing was published and the cursor was kept. A sustained count usually means the site changed its layout.
- `pipeline.refresh.due` and `pipeline.refresh.published`: published HN stories that met the refresh rule, and those moved back to `triaged_pass` with a deep job enqueued. Each claimed revision updates the existing desk document without creating another Discord delivery (see [ARCHITECTURE.md](../ARCHITECTURE.md#3-hacker-news)).
- `pipeline.sweep.selected`, `pipeline.sweep.recovery`, `pipeline.sweep.published`, and `pipeline.sweep.snapshots_deleted`: rows selected by each bounded query, committed recoveries by prior state, republished jobs, and old HN snapshots deleted.
- `pipeline.delivery.transition`: emitted only on the feed-only path in `apps/pipeline/src/worker.ts`, when a legacy delivery job is suppressed with reason `rollout_feed_only`. Normal webhook deliveries (`delivery.feed_only: false`) emit no delivery-transition metric or log; read the delivery row instead (see [Delivery outcomes](#delivery-outcomes)).

Logs `pipeline.message_acknowledged`, `pipeline.message_failed`, `pipeline.item_transition`, `pipeline.analysis_completed`, and `pipeline.delivery_transition` (feed-only suppressions only) report committed state; item and delivery attempts are independent of queue attempts. Console samples are best-effort observations: there is no aggregation, dashboard, alarm, queue-depth, or DLQ-depth signal. Use persisted state to settle disagreements.

## Delivery outcomes

With `delivery.feed_only: false`, the webhook notifier classifies each send:

| Provider response                                                                                     | Error code              | Delivery state                                                    |
| ----------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------- |
| 2xx with a readable receipt (Discord) or any 2xx (Slack)                                              | —                       | `sent`                                                            |
| 5xx                                                                                                   | `UPSTREAM_UNAVAILABLE`  | `failed_retryable`, then `failed_permanent` when attempts run out |
| 429                                                                                                   | `UPSTREAM_RATE_LIMITED` | `failed_retryable`, then `failed_permanent` when attempts run out |
| Other non-success, including a redirect                                                               | `UPSTREAM_REJECTED`     | `failed_permanent`                                                |
| No response, an unreadable Discord receipt, or no answer within `timeouts.notifier_ms` (default 10 s) | `OUTCOME_UNKNOWN`       | `unknown`                                                         |

Retries follow `retry.deliver` (5 attempts; backoff 30, 120, 600, and 1800 seconds with jitter); the last retryable failure is recorded as `ATTEMPTS_EXHAUSTED`. The timeout stops waiting but cannot cancel the request, which is why it is an unknown outcome rather than a retry.

These transitions emit no delivery-transition telemetry on `main`; only the generic per-message signals (`pipeline.queue.disposition`, `pipeline.job.duration_ms`, `pipeline.message_acknowledged`, and `pipeline.message_failed`) mark the `deliver` job. Read the delivery row (`state`, `attempts`, `last_error`, `next_attempt_at`) to follow a send. The sweep's move of an expired `sending` row to `unknown` is counted under `pipeline.sweep.recovery`.

## Diagnose stalled work

1. Check readiness without creating a job: an active published configuration and usable D1, R2, and queue bindings. A bad invocation envelope or unusable configuration rejects before per-job telemetry. The desk's `GET /healthz` only proves its D1 is reachable: it returns `{"status":"ok"}` even when no configuration is published. Confirm a `config_versions` row with read-only tooling; the pipeline has no readiness endpoint.
2. Check `pipeline.dispatch_failed`, `pipeline.refresh_failed`, and `pipeline.sweep_failed` separately. Each tick runs dispatch, refresh, and sweep independently and reports every branch that fails. A later tick can rediscover ready work without editing a queue.
3. Read persisted work through approved read-only tooling. For polling, check the slot's bucket and lease, then the source's `next_poll_at` and failure count. For items and deliveries, inspect `state`, `state_updated_at`, `attempts`, and `next_attempt_at`. A future retry time or live lease is not stuck.
4. Compare with the next bounded sweep. Each query selects at most 100 rows; observing 100 means the query hit its cap, not that the backlog is 100. The consumer, not the sweep, enforces exhaustion and checks for reusable completed analysis.
5. Escalate repeated capped selections without progress, persistent branch failures, or aged ready rows that survive successive ticks. Give the owner the time range, classified errors, affected states, safe correlation IDs, and configuration version. Do not manually edit queues, resubmit uncertain messages, or mutate rows to clear an alert.

## Treat `unknown` delivery as unresolved

An expired `sending` lease is fenced to `unknown` with `OUTCOME_UNKNOWN`; the sweep does not enqueue it. A notifier can also produce an unknown outcome before lease expiry. Neither proves that a send did or did not happen.

Do not resend an `unknown` delivery, reset it to `pending`, or release its reservation. Escalate to the owner for reconciliation using read-only evidence; any remediation needs an approved operational action that cannot duplicate a send.

## Before changing production

- Deploying to `prod`, running production migrations, creating resources, and changing credentials or configuration need the owner's approval at the point of operation.
- Review a drain or migration plan before changing the configuration or a prompt version with work pending: a pending analysis can keep an older configuration version while a retry uses the active one.
- On a deployed Worker, `PINNED_WEB` re-resolves the hostname when it fetches; only the local runner connects to the checked address. Do not widen the web watchlist to untrusted hosts on that assumption.

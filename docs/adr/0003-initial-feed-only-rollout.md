# ADR-0003: Initial feed-only rollout

- **Status**: Accepted
- **Date**: 2026-11-21

> **Note (2026-11-24)**: on `main`, feed-only is the `delivery.feed_only` configuration switch (default `true`). With `feed_only: false`, finalization plans deliveries and the `q-deliver` consumer runs the webhook notifier; the seed SQL printed by `tools/local/seed-sql.ts`, applied by hand at initialization, sets `feed_only: false` with one Discord destination. The desk is now public. This record keeps the original decision; [ARCHITECTURE.md](../../ARCHITECTURE.md#analysis-and-publication) describes current behavior.

## Context

Model-generated alerts are useful in the authenticated desk. Existing citation,
link, and translation checks constrain what is published; they do not establish
that generated prose is semantically trustworthy enough to send to other systems.

## Decision

The initial pipeline is feed-only. Analysis and validated language documents
are unchanged. Finalization records a qualifying new alert as `feed_only`
with `rollout_feed_only` and inserts no delivery rows. Program-owned
qualification and language selection still run; neither model output nor
stored delivery configuration can enable Slack, Discord, or simulated sends.

The `q-deliver` consumer has no live executor or notifier wired in. It fences
legacy `pending` and `failed_retryable` rows into terminal `suppressed` with
reason `rollout_feed_only`, without claiming a send, reading credentials or
debiting a budget. An already-queued job can be suppressed before its retry
time; the existing bounded sweep can discover unqueued work when due. Duplicate
messages do not change terminal rows. Legacy dry-run rows are suppressed by the
same rule, not converted into real or simulated sends.

## Alternatives considered

An editable pause or force-dry-run default is not a restriction; configuration
could defeat it, and simulated `sent` is not approval. A durable, authenticated
human-review workflow is a separate product and security decision; a heuristic
or citation pass cannot replace it.

## Consequences

No backfill or future release of suppressed work is implied. Existing alerts,
documents, `sent` and `unknown` outcomes, reservations and prior debits retain
their history under [ADR-0002](./0002-b2-durable-work.md). The existing sweep
still fences stale `sending` rows to `unknown`; an older in-flight request
cannot be recalled.

No SQL migration or queue version change is needed. The new reason extends
strict row decoders: use compatible readers before the first new writes.
Older consumers can still send remaining eligible rows, so stop or isolate
them before cutover. Do not roll back to an older sending consumer or reset
rows to get around a decoder incompatibility. Review pending work and stop
controls before any separately authorized deployment.

## Review triggers

Revisit before adding approval or enabling real delivery. This ADR does not
approve deployment or close any [production gate](../archive/b5-rollout-checklist.md).

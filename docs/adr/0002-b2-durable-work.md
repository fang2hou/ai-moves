# ADR-0002: Durable B2 Work and Read Boundaries

- **Status**: Accepted
- **Date**: 2026-11-21

## Context

The v1 architecture makes storage authoritative and queues at least once. A queue send and a storage write cannot commit together. Reserving a poll by moving `next_poll_at` can lose work after a crash; only moving it after enqueue does not elect a consumer or handle partial publication.

## Decision

Persist one poll slot per source. A pending slot retains its original `(source_id, tick_bucket)` until a fenced consumer completes it; the completed slot retains the bucket to reject stale ticks. Schedulers publish ready slots without marking them sent. A live lease hides a claimed slot until expiry; completion atomically updates the source cursor and schedule. This clarifies the poll schedule row in architecture §4.2: snapshot deduplication is independent of reserving a poll.

Reuse item and delivery state for their wake-ups, with claim-version checks to reject stale writers. Lease each pending analysis separately and make its final completion immutable. Persist budget receipts by scope and work ID; decouple a replay of a debit from permission to repeat an outbound call. Persist validated, channel-neutral alert documents by language in the same transaction as alert and delivery creation.

Use bounded, keyset-ordered feed queries and write operator changes together with their audit rows. The administrative destination projection excludes secret references at the storage boundary.

## Alternatives

- Updating the source before or after publishing cannot close both crash windows. A generic outbox with send acknowledgements would still have an ambiguous send/ack window and is unnecessary for rediscoverable work.
- Sharing model or translation wire payloads with delivery would require delivery to own validation and reassembly, or depend on changing prompt schemas. Persist the small final document instead.
- Calculating budget use from completed work would omit calls that succeeded upstream but lost their result. Debit before the call; ambiguous attempts keep their debit.

## Consequences

Duplicate queue messages and abandoned leases are expected. A lease fences state writes, not an already-started external request. Concurrent configuration publishes require the expected version; runtime reads and deployment boundaries do not change.

Migration `0002_b2_shared_work` only expands the B1 schema. B1 alerts without documents remain readable, but document lookup returns `null`; do not send them using guessed content. Queue version 1 remains unchanged. See the [B2 handoff](../b2-shared-handoff.md) for consumer sequencing.

## Review Triggers

Revisit this design if the pipeline needs overlapping polls per source, lease renewal, or reconciliation with a provider that offers authoritative request outcomes.

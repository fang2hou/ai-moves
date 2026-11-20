# B2 Shared Port Handoff

Use `@ai-moves/contracts/ports/storage` and `@ai-moves/contracts/alert-doc`. The composition roots select `@ai-moves/storage/d1` or `@ai-moves/storage/memory`; use-case packages receive ports, never adapters. Contract version `1.2.0` leaves all queue messages at version 1.

## S2.1 — Ingestion and recovery

1. Compute the five-minute bucket from the scheduled tick. Call `sources.scheduleDue(now, tickBucket, limit)` before any enqueue. Then read `sources.listReadyPolls(now, limit)` and enqueue the returned source IDs and **stored** buckets. Repeat on later ticks, including after partial batch failure. Do not advance source state or acknowledge publication in the dispatcher.
2. Call `sources.claimPoll(job, { owner, now, expiresAt })` before contacting the upstream. Use a fresh, unique owner ID per attempt. `null` means this message does not own the slot. Reuse `tick_bucket` as the stable sampling identity across retries; a snapshot's `sampled_at` must come from the bucket, not the retry clock.
3. Persist observations, revisions, and downstream item states before `finishPoll(work, owner, outcome)`. It updates the cursor, counters and next poll together, only before the lease expires. Use the current clock for `outcome.at`. A lost claim must not be retried as an unconditional write. A crash before completion leaves the same bucket rediscoverable.
4. Downstream wake-ups follow durable state, not the queue send result. Sweep `candidate`, `triaged_pass`, and other resumable states with `items.listStale({ states, updatedBefore, readyAt: now, limit })`. Use `readyAt` to exclude retry backoff and the exclusive `updatedBefore` for staleness. Recover a lease with `transition({ expected: observedRow, ... })` and increment attempts on each new claim, including a same-millisecond claim. Use `deliveries.listDue(now, limit)` for pending and retryable delivery wake-ups. Recover expired `sending` as `unknown`, never by republishing it as ready.

## S2.2 — Analysis and prepared documents

Keep the existing analysis key and normalized outputs. `insertIfAbsent` saves inputs and provenance; it does not claim the work. Use the item-state CAS, then `analyses.claim(id, lease)` with a fresh owner ID for each stage/language execution. Call the model only after the claim and a granted budget receipt. Terminal `analyses.complete(id, owner, result)` returns `false` for expired, replaced, or already-finished claims. Retryable failures leave the row pending for expiry and retry; bound and schedule retries via item state and configuration. Reuse completed rows if the item update or wake-up was interrupted. Do not change item state or publish a result after losing the claim.

Construct `AlertDoc` from completed analysis, verified translations, and program-owned identities and URLs. Preserve normalized assessments and translations separately in `Analysis.output_json` or content-addressed blobs; `AlertDoc` is the rendering handoff, not a model output schema. After an interrupted finalization, replay from those persisted results without another model call. Use a stable alert key and pass the alert, validated documents, and delivery planning inputs to finalization through composition using contract values.

For `budgets.tryConsume`, use the unique analysis lease owner as `workId` for that model invocation. A second storage call with the same `(scope, workId)` reuses the receipt; a new invocation after recovery needs a fresh debit. This lets the hard limit bound invocations even if an abandoned call reached the provider.

For changelog triage, also charge `changelogTriageBudgetScope({ owner, repo })` from `@ai-moves/contracts/entities` against `changelog.max_triage_per_repo_per_day` (default 3). Charge one unit for each newly attempted execution, using its UTC date and the same `workId` as the global triage charge. Case variants resolve to one repository scope; invalid identities are rejected. Reusing a completed result does not debit either scope.

## S2.3 — Alert finalization and delivery

`alerts.insertWithDeliveries(alert, deliveries, documents)` commits the alert, its validated language documents, and deliveries atomically. Supply one document per language for every sendable delivery, using the canonical alert ID, kind and tier. Feed-only alerts can omit documents when none are valid. On alert-key replay, use the returned canonical alert and its `deliveries.listByAlert(id)` rows, not newly generated IDs. The delivery sweeper can recover a partial publication.

Use `alerts.getDocument(delivery.alert_id, delivery.lang)`; `null` does not authorize a render, fallback, or send. Evaluate non-history policy first (pass `minutesSincePrevious: null` and `updatesSent: 0` to `decideDelivery`); record deterministic suppression from `pending` or `failed_retryable`. Pass the observed state and version to `deliveries.claimForSend({ id, from, expected, at, minIntervalMinutes, maxUpdatesPerItem })` for any **live** attempt. Use the current clock and the effective config limits. The repository returns:

- `claimed`: the returned delivery is `sending` with incremented `attempts`. Use it as the `expected` version for the outcome.
- `suppressed`: already terminal with `rate_limit` or `update_limit`; do not debit or send.
- `unavailable`: no claim; do not debit or send. This includes stale, not-yet-due, expired, already-claimed and stored dry-run rows.

The live gate spaces distinct alerts globally and counts distinct update alerts per item. Fan-out of one alert does not add another slot. An in-flight reservation counts immediately; `sent` or `unknown` starts the interval at its recorded outcome time and continues to occupy an update slot. Only a known-unsent outcome releases a reservation; an expired `sending` lease becomes `unknown`, never a retry. Dry runs use the fenced `transition` without a live reservation and do not create live history.

After a won claim, debit each budget scope with an ID such as `stableKey("delivery-attempt", delivery.id, String(claimed.attempts))`. Send only after every grant. A denial after reservation is a known-unsent terminal failure (`BUDGET_EXHAUSTED`), which releases the policy reservation; no budget debit is refunded. Use the same fenced completion for a known-unsent provider failure; an ambiguous result must become `unknown`.

Receipts pin the outcome and original day. A repeat with a different amount is a conflict; a repeat with a different day or limit does not move or overwrite the receipt. For fresh work a scope/day keeps the limit that initialized its ledger. Use the current ledger limit if it is already established; new configured limits apply at the next ledger day.

## S2.4 — API and web

- `items.listFeed({ limit, before? })` lists currently `alerted` or `feed_only` items by descending `(first_seen_at, id)`. `alerts.listFeed({ limit, before?, itemId? })` lists alerts by descending `(created_at, id)`; use `itemId` for detail history. Both use exclusive `{ at, id }` cursors, binary ID ties, and a limit of 1–100. Use the last returned row as the next cursor. These are live keyset reads, not snapshots across pages.
- Use `items.get`, `alerts.get`, `alerts.getDocument`, and `deliveries.listByAlert` for detail as appropriate. Deliberately map response fields; do not serialize raw model payloads or arbitrary audit details.
- Use `admin.listDestinations()` for `DestinationSummary`, not `destinations.list()`. Validate the request with `DestinationPatchSchema`; pass the authenticated actor, fresh audit ID, and current time to `admin.patchDestination(id, patch, change)`. `false` means the target is missing or the audit ID is already used; neither case writes an audit row or a policy change.
- Use `config.getCurrent()` and `admin.publishConfig(config, expectedVersion, change)` for audited configuration overrides. Start at expected version `0` when no config exists. `null` means the version is stale or the audit ID is already used. Do not implement an API update as `config.publish` followed by `audit.append`.

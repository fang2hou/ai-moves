# Ingestion

Schedules source polling, stores normalized observations, and recovers durable downstream work. This package does not configure a Worker, contact a provider directly, or send alerts.

| Import                      | Function                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@ai-moves/ingestion/tick`  | `dispatchDueSources(ports, event, limit)` reserves due poll slots and publishes ready jobs using the buckets already in storage.          |
| `@ai-moves/ingestion/poll`  | `pollSource(ports, job, options)` claims one poll, stores the observations, and completes the slot before publishing triage jobs.         |
| `@ai-moves/ingestion/sweep` | `sweepStaleWork(ports, options)` wakes stale ready items and due deliveries, recovers expired analysis work, and prunes old HN snapshots. |

The composition root supplies a shared clock, an ID generator with unique IDs across invocations, and injected source, storage, blob and queue ports. Set `leaseMs` longer than the expected bounded polling time. Run dispatch and sweep on the five-minute tick independently so a transient publication failure in one does not block the other.

An HN sample uses the stored poll bucket even after lease expiry; the first persisted sample for that bucket wins. HN scoring normalizes each feature against the fixed reference rates in `hn.reference` rather than a cross-day distribution. GitHub polling uses the configured release, tag and changelog-file strategy. Release and tag validators are conditional; the changelog cursor contains a content SHA, so it detects unchanged files after a read rather than sending the SHA as an HTTP ETag. A `web_page` source polls a documentation changelog that has no repository. Its cursor holds the content hash of the page and the newest release seen for each followed product surface; the page is split into releases, each release is its own item, and a first read takes only the newest release of each surface. Both readers produce `ChangelogEntry` values and share one observation path. Normalized notes go to content-addressed storage. An unchanged body creates no revision.

A completed backoff is returned as `backoff` with a redacted error summary. `not_claimed` and `claim_lost` do not authorize a cursor write or publication. Storage and queue exceptions propagate. A lost or partially accepted publication is recovered from durable rows; neither a successful queue send nor a redelivery proves completion. The sweeper releases expired analysis leases without changing the attempt count, so consumers can adopt persisted results before enforcing exhaustion. Expired `sending` deliveries become `unknown` and are never woken for another send.

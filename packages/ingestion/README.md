# Ingestion

Schedules source polls, reads the three source families, stores normalized observations, and recovers durable downstream work. It does not configure a Worker, contact a provider directly, or send alerts; sources, storage, blobs, and queues arrive as injected ports.

| Import                        | Function                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ai-moves/ingestion/tick`    | `dispatchDueSources(ports, event, limit)` reserves due poll slots for the tick's bucket and publishes the ready ones                                                          |
| `@ai-moves/ingestion/poll`    | `pollSource(ports, job, options)` claims one poll, reads the source, stores observations, and completes the slot before publishing triage jobs                                |
| `@ai-moves/ingestion/refresh` | `refreshPublishedItems(ports, config, limit)` sends published HN stories whose discussion grew back to deep analysis                                                          |
| `@ai-moves/ingestion/sweep`   | `sweepStaleWork(ports, options)` wakes stale ready items and due deliveries, releases expired analysis leases, fences expired sends to `unknown`, and prunes old HN snapshots |

The pipeline runs dispatch, refresh, and sweep independently on every tick, so a failure in one does not block the others.

## Source readers

- **Web changelogs** (`src/web.ts`, `src/sections.ts`): an unchanged page hash ends the poll. Otherwise one generic splitter finds releases by versioned Markdown headings or bold lines (a second-level heading without a version names a product surface), falling back to dated product lines. Each release is one item; the cursor keeps a high-water marker per followed surface, and a first read takes only the newest release of each. A changed page that yields no followed release publishes nothing, keeps its cursor, and counts `pipeline.poll.unsplit`. Explicit per-site parsers are the scheduled target.
- **GitHub** (`src/github.ts`): `release_first`, `tags_plus_changelog`, or `changelog_file`. Release and tag lists are conditional on stored ETags; the changelog cursor stores a content SHA. A first read records everything but the newest entry as historical, so it is never analyzed.
- **Hacker News** (`src/hn.ts`): snapshots the top stories plus tracked ones, computes `vp`, `vc`, `climb`, and `acc` over the scoring window, and scores them with `@ai-moves/core/scoring/hn`. Any of the burst, discussion, or sustained gates makes a story a `candidate`.

GitHub and web entries share one observation path (`src/changelog.ts`): normalized notes go to content-addressed blob storage, and an unchanged body creates no revision.

## Refresh

A published story (`feed_only` or `alerted`) is due when it is younger than `ai.refresh_max_age_hours`, its state is older than `ai.refresh_interval_minutes`, and the snapshots taken since its analysis show at least `ai.refresh_min_new_comments` new comments. It moves back to `triaged_pass` and a deep job is enqueued.

**Known limitation on `main`**: the deep job keys its analysis on the comment count frozen in `score_json` (`itemSnapshotHash` in `packages/analysis/src/work.ts`), so it replays the stored analysis and the document does not change. A fix is scheduled in a follow-up pull request.

## Failure handling

A completed backoff returns `backoff` with a redacted error summary. `not_claimed` and `claim_lost` never authorize a cursor write or publication. Storage and queue exceptions propagate. A lost or partially accepted publication is recovered from durable rows; neither a successful queue send nor a redelivery proves completion. The sweep releases expired analysis leases without changing the attempt count, so consumers can adopt persisted results before enforcing exhaustion. Expired `sending` deliveries become `unknown` and are never woken for another send.

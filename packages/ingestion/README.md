# Ingestion

Schedules source polls, reads the three source families, stores normalized observations, and recovers durable downstream work. It does not configure a Worker, contact a provider directly, or send alerts; sources, storage, blobs, and queues arrive as injected ports.

| Import                        | Function                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ai-moves/ingestion/tick`    | `dispatchDueSources(ports, event, limit)` reserves due poll slots for the tick's bucket and publishes the ready ones                                                          |
| `@ai-moves/ingestion/poll`    | `pollSource(ports, job, options)` claims one poll, reads the source, stores observations, and completes the slot before publishing HN deep jobs or changelog triage jobs      |
| `@ai-moves/ingestion/refresh` | `refreshPublishedItems(ports, config, limit)` sends published HN stories whose discussion grew back to deep analysis                                                          |
| `@ai-moves/ingestion/sweep`   | `sweepStaleWork(ports, options)` wakes stale ready items and due deliveries, releases expired analysis leases, fences expired sends to `unknown`, and prunes old HN snapshots |

The pipeline runs dispatch, refresh, and sweep independently on every tick, so a failure in one does not block the others.

## Source families

GitHub and web entries share one observation path (`src/changelog.ts`): normalized notes go to content-addressed blob storage, and an unchanged body creates no revision.

### Web changelogs

`src/web.ts` reads a `web_page` source, which names a page, an optional `fetch_url` (a Markdown twin where the site serves one), and the product surfaces to follow. The [parser registry](./src/parsers/registry.ts) selects a parser by public page hostname, and the page comes through the [`@ai-moves/sources/web`](../sources/README.md) adapter.

- An unchanged page body (same content hash) ends the poll. Claude Code uses versioned Markdown headings or bold lines, ChatGPT and Codex use dated product entries in extracted HTML text, and Antigravity groups versioned Markdown releases by surface. The generic fallback looks for Markdown or dated release markers when a hostname has no parser or its parser finds no releases.
- Each release is its own item. Stored markers and item keys retain their existing format. The cursor keeps a high-water marker per surface. A first read takes only the newest release of each surface, and subsequent reads take the releases above a recognized marker. When the page changes and the marker is still newest, the poll re-observes that release, checks it for notes revisions, and deduplicates it by notes hash.
- When nothing on the page splits into a followed release, nothing is published, the cursor is kept, and `pipeline.poll.unsplit` is counted. A whole page is never published as one item.

Watched pages: Claude Code, ChatGPT and Codex, and Antigravity (App and CLI surfaces only), polled every 30 minutes by default.

### GitHub releases

`src/github.ts` reads a `github_repo` source through the [`@ai-moves/sources/github`](../sources/README.md) adapter.

- `release_first` lists releases (one page of 10, conditional on the stored ETag) and skips drafts. A repository with no releases falls back to tags and then to the changelog file.
- `tags_plus_changelog` lists tags (conditional on the stored ETag) and attaches the matching version section of the changelog file.
- `changelog_file` reads one file as a single item; its cursor stores the content SHA, not an HTTP validator.
- Cold start is newest-only: on a first read (no known versions) every entry after the newest is recorded as historical and never analyzed.
- Release freshness, the changelog prior score, and revision rules determine eligibility for triage. Watched repositories are listed in the seed SQL that `tools/local/seed-sql.ts` prints; the default poll interval is 10 minutes.

### Hacker News

Each poll, `src/hn.ts` snapshots the top 30 (`hn.top_n`) plus previously seen stories still being tracked (up to `hn.track_limit`, 60): rank, points, and comments. It computes `vp`, `vc`, `climb`, and `acc` over the scoring window and scores them with [`@ai-moves/core/scoring/hn`](../core/README.md#hacker-news-scoring), which defines the features, the scoring window, the heat score, and the gates. Any gate moves a newly qualified story directly to `triaged_pass`, and the poll queues a deep job. Later observations continue to record snapshots.

The activity sample includes currently ranked stories with at least two observations, including ranked stories already analyzed or published. Cold stories and unranked tracked stories contribute no velocity to the activity calculation. The poll applies the same `hn.activity` factor to every score and recomputes prior gate heats using that factor. Stored features stay in their original units.

Cadence: production ticks every 5 minutes (`*/5 * * * *`), matching the HN source interval. Six regular observations span 25 minutes from first to last.

## Refresh

Each tick, `refreshPublishedItems` selects published stories (`feed_only` or `alerted`) that are due and moves them back to `triaged_pass` with a deep job enqueued. A story is due when it is younger than `ai.refresh_max_age_hours` (24 hours by default), its state is older than `ai.refresh_interval_minutes` (180 by default, so at least three hours after analysis), and the snapshots taken since its analysis show at least `ai.refresh_min_new_comments` new comments (20 by default).

Each claimed refresh increments the item revision. Deep analysis reads the previous document and prioritizes comments it did not cite. Finalization replaces the original alert documents in place with `replaceDocuments`, preserving its decision and deliveries. A retry reuses the analysis for that revision.

## Failure handling

A completed backoff returns `backoff` with a redacted error summary. `not_claimed` and `claim_lost` never authorize a cursor write or publication. Storage and queue exceptions propagate. A lost or partially accepted publication is recovered from durable rows; neither a successful queue send nor a redelivery proves completion. The sweep releases expired analysis leases without changing the attempt count, so consumers can adopt persisted results before enforcing exhaustion. Expired `sending` deliveries become `unknown` and are never woken for another send.

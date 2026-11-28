# Ingestion

Schedules source polls, reads the three source families, stores normalized observations, accepts reader submissions, and recovers durable downstream work. It does not configure a Worker, contact a provider directly, or send alerts; sources, storage, blobs, and queues arrive as injected ports.

| Import                                  | Function                                                                                                                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ai-news-tracker/ingestion/tick`       | `dispatchDueSources(ports, event, limit)` reserves due poll slots for the tick's bucket and publishes the ready ones                                                                                                                          |
| `@ai-news-tracker/ingestion/poll`       | `pollSource(ports, job, options)` claims one poll, reads the source, stores observations, and completes the slot before publishing HN deep jobs or changelog triage jobs                                                                      |
| `@ai-news-tracker/ingestion/refresh`    | `refreshPublishedItems(ports, config, limit)` sends published HN stories whose discussion grew back to deep analysis                                                                                                                          |
| `@ai-news-tracker/ingestion/submission` | `submitItem(ports, input, submitter, options)` stores a reader's markdown as a `submission` item and queues triage (`score`) or deep analysis (`publish`); `listSubmissions`, `forceSubmission`, and `rereviewSubmission` serve the dashboard |
| `@ai-news-tracker/ingestion/sweep`      | `sweepStaleWork(ports, options)` wakes stale ready items and due deliveries, releases expired analysis leases, fences expired sends to `unknown`, and prunes old HN snapshots                                                                 |

The pipeline runs dispatch, refresh, and sweep independently on every tick, so a failure in one does not block the others.

## Source families

GitHub and web entries share one observation path (`src/changelog.ts`): normalized notes go to content-addressed blob storage, and an unchanged body creates no revision.

### Web changelogs

`src/web.ts` reads a `web_page` source, which names a page, an optional `fetch_url` (a Markdown twin where the site serves one), and the product surfaces to follow. The [parser registry](./src/parsers/registry.ts) selects a parser by public page hostname, and the page comes through the [`@ai-news-tracker/sources/web`](../sources/README.md) adapter.

- An unchanged page body (same content hash) ends the poll. Claude Code uses versioned Markdown headings or bold lines, ChatGPT and Codex use dated product entries in extracted HTML text, and Antigravity groups versioned Markdown releases by surface. The generic fallback looks for Markdown or dated release markers when a hostname has no parser or its parser finds no releases.
- Each release is its own item. Stored markers and item keys retain their existing format. The cursor keeps a high-water marker per surface. A first read takes only the newest release of each surface, and subsequent reads take the releases above a recognized marker. When the page changes and the marker is still newest, the poll re-observes that release, checks it for notes revisions, and deduplicates it by notes hash.
- When nothing on the page splits into a followed release, nothing is published, the cursor is kept, and `pipeline.poll.unsplit` is counted. A whole page is never published as one item.

Watched pages: Claude Code, ChatGPT and Codex, and Antigravity (App and CLI surfaces only), polled every 30 minutes by default.

### GitHub releases

`src/github.ts` reads a `github_repo` source through the [`@ai-news-tracker/sources/github`](../sources/README.md) adapter.

- `release_first` lists releases (one page of 10, conditional on the stored ETag) and skips drafts. A repository with no releases falls back to tags and then to the changelog file.
- `tags_plus_changelog` lists tags (conditional on the stored ETag) and attaches the matching version section of the changelog file.
- `changelog_file` reads one file as a single item; its cursor stores the content SHA, not an HTTP validator.
- Cold start is newest-only: on a first read (no known versions) every entry after the newest is recorded as historical and never analyzed.
- Release freshness and revision rules determine eligibility. A release is timely when it is not historical and was published within `delivery.expiry_hours.changelog` (or has no date); every timely release becomes a candidate and is published and sent, with no scoring, and a historical or expired one stays in `tracking`. A later revision of an `alerted` item (or of a once-rejected one) makes it a candidate again only when the notes changed by at least `changelog.min_revision_diff_chars` (200). Deep analysis then rereads the release and finalization replaces the documents of its published alert in place, as an HN [refresh](#refresh) does: the desk shows the current notes, no second alert is pushed, and the item returns to `alerted`, so each later revision is read the same way. The item's `score_json` is `{ kind: "changelog", computed_at }`; older rows still carry a `prior` and `signals`, which parsing drops. Watched repositories are listed in the seed SQL that `tools/local/seed-sql.ts` prints; the default poll interval is 10 minutes.

### Hacker News

Each poll, `src/hn.ts` snapshots the top 30 (`hn.top_n`) plus previously seen stories still being tracked (up to `hn.track_limit`, 60): rank, points, and comments. It computes `vp`, `vc`, `climb`, and `acc` over the scoring window and scores them with [`@ai-news-tracker/core/scoring/hn`](../core/README.md#hacker-news-scoring), which defines the features, the scoring window, the heat score, and the gates. Before scoring, the poll sends every scored story that no earlier poll judged (up to `hn.relevance.max_batch`, 60) to the injected relevance judge in one model call; the verdict and the judge's prompt version are stored in the score and reused by later polls until the version changes, when the story is asked again. The judge is absent while `ai.enabled` is false, and a story left unjudged is scored at weight 1, cannot qualify while `hn.relevance.block_unrelated` is true, and is asked about again next poll. An `unrelated` story carries no gates while `hn.relevance.block_unrelated` is true, so it never qualifies, however hot it runs. Any gate moves a newly qualified story directly to `triaged_pass`, and the poll queues a deep job. Later observations continue to record snapshots, and while a published (`alerted` or `feed_only`) story stays ranked each poll writes its points and comments to the score's `latest` field, leaving the qualifying score and features unchanged.

The activity sample includes currently ranked stories with at least two observations, including ranked stories already analyzed or published. Cold stories and unranked tracked stories contribute no velocity to the activity calculation. The poll applies the same `hn.activity` factor to every score and recomputes prior gate heats using that factor. Stored features stay in their original units.

Cadence: production ticks every 5 minutes (`*/5 * * * *`), matching the HN source interval. Six regular observations span 25 minutes from first to last.

### Submissions

`src/submission.ts` is not a poller. A signed-in reader's markdown arrives through the pipeline's MCP endpoint and `submitItem` stores it:

- The input is validated against `SubmissionInputSchema` (`INPUT_INVALID` on failure), and a `source_url` carrying credentials is rejected.
- Every submission belongs to one sentinel source (id and key `submission`, kind `submission`). `submitItem` creates the row on first use with `sources.upsert`, which is idempotent on `key` and keeps an existing row's cursor and counters. The row's `next_poll_at` is the end of year 9999, so the tick never schedules it, and `pollSource` finishes a claimed poll of it with no read and no candidates.
- The item's `external_key` is `submission:` plus a SHA-256 of the canonical `source_url` (fragment and `utm_*` parameters removed, parameters sorted, host lower-cased), so one item exists per page; the item's `url` is the submitted URL as validated. A page that was already submitted returns its item with `created: false`; the first submitter's name stays on it. A display name containing `@` is published only up to the `@`, so an identity that uses the email as its name never exposes the address.
- A new item's markdown body goes to blob storage as `text/markdown` with a revision of origin `submission`. The item moves from `discovered` to `candidate` for `score` or to `triaged_pass` for `publish`, with the content hash, revision 1, a `SubmissionScore` that carries the submitter, and a cluster key. Triage (the AI reviewer, see [`@ai-news-tracker/analysis`](../analysis/README.md#submissions)) or deep analysis is then enqueued. A `discovered` row left by a crash before this finished is completed by the next submission of the same page.
- A lost enqueue is recovered by the sweep, which wakes stale `candidate` and `triaged_pass` items.
- The stored score starts with `review: null` and `forced_by: null`; the AI reviewer fills `review` for a `score` submission.

`listSubmissions(ports, { limit, deskOrigin, legacyRejectionReason })` returns the dashboard rows (`SubmissionListSchema`): the sentinel source's submissions in every state, newest `first_seen_at` first, 50 by default and at most 100. A repository returns each state's items in id order, so the list reads each state separately (up to 100 each) and sorts the union; a state holding more than 100 submissions shows an arbitrary 100 of them. Each row carries the submitter's public name, mode, state, the stored review, the latest alert's decision, `blocked_by`, and importance, `forced_by`, `can_force` (the state is in `FORCEABLE_SUBMISSION_STATES`), and `can_rereview` (`triaged_reject`). A `triaged_reject` item with no review falls back to the rejection reason of the older triage analysis; ingestion cannot compute that row's key, so the pipeline passes the lookup as `legacyRejectionReason`, and the row's comment then has a null score. A row still in `discovered` has no submitter and is skipped. No row carries an email.

`forceSubmission(ports, itemId, forcer, options)` handles a force publish. The item must be a submission in `triaged_reject`, `failed_analysis`, or `feed_only` (`NOT_FOUND` for an unknown item, `INPUT_INVALID` for another state). It moves the item to `triaged_pass` with its score switched to `publish`, `forced_by` set to the forcer's public display name (the same `@` rule as the submitter's name), the revision incremented, attempts reset, and a deep job enqueued. The new revision gives deep analysis a new input: a rejected item gets its first alert, and a `feed_only` item gets an `update` alert that `publish` mode sends. The reviewer's earlier verdict stays on the item. It returns the new row.

`rereviewSubmission(ports, itemId, options)` sends a `triaged_reject` submission back through the current reviewer (`NOT_FOUND` for an unknown item, `INPUT_INVALID` for another state). It moves the item to `candidate` with the review cleared, mode `score`, the revision incremented, and attempts reset, and enqueues a triage job. The new revision gives triage a fresh analysis key, so the reviewer runs again instead of replaying its stored verdict; the outcome follows the normal `score` path. It returns the new row.

## Refresh

Each tick, `refreshPublishedItems` selects published stories (`feed_only` or `alerted`) that are due and moves them back to `triaged_pass` with a deep job enqueued. A story is due when it is younger than `ai.refresh_max_age_hours` (24 hours by default), its state is older than `ai.refresh_interval_minutes` (180 by default, so at least three hours after analysis), and the snapshots taken since its analysis show at least `ai.refresh_min_new_comments` new comments (20 by default).

Each claimed refresh increments the item revision. Deep analysis reads the previous document and prioritizes comments it did not cite. Finalization replaces the original alert documents in place with `replaceDocuments`, preserving its decision and deliveries. A retry reuses the analysis for that revision.

## Failure handling

A completed backoff returns `backoff` with a redacted error summary. `not_claimed` and `claim_lost` never authorize a cursor write or publication. Storage and queue exceptions propagate. A lost or partially accepted publication is recovered from durable rows; neither a successful queue send nor a redelivery proves completion. The sweep releases expired analysis leases without changing the attempt count, so consumers can adopt persisted results before enforcing exhaustion. Expired `sending` deliveries become `unknown` and are never woken for another send.

# Architecture

AI Moves watches three families of sources (documentation changelogs, GitHub releases, and the Hacker News front page), scores what changed with deterministic rules, runs budgeted model analysis on what qualifies, and publishes the result to a public read-only desk and, when enabled, to Discord. Domain logic lives in portable packages; Cloudflare and provider details live in adapters and composition roots, so the system can move to AWS without rewriting domain code.

Each section separates **Current (`main`)** from **Target / Scheduled next** wherever the two still differ. Treat a target as unbuilt until a section says otherwise.

## System Overview

```text
cron tick ──► dispatch due sources ──► q-poll ──► poll: HN | GitHub | web changelog
                                                     │  items, snapshots, cursors (D1); notes (R2)
                                                     ▼  qualifying item → candidate
                                      q-triage ──► triage (model) ──► q-deep ──► deep analysis,
                                                                                 polish, translation
                                                                                     │
                                                    alert + language documents (D1) ◄┘
                                                         │                     │ delivery.feed_only = false
                                                         ▼                     ▼
                                           public desk (apps/api + apps/web)   q-deliver ──► webhook (Discord)
```

The same tick also runs the refresh pass for published Hacker News stories and the sweep that recovers stalled work. D1 is the correctness store: every queue message is a wake-up that names durable rows, and the sweep can rediscover any work whose message was lost.

| Deployment unit                 | Source          | Runs                                                                                                                   |
| ------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Pipeline Worker                 | `apps/pipeline` | `scheduled` (tick: dispatch, refresh, sweep), `queue` (poll, triage, deep, deliver), and a token-gated `POST /trigger` |
| Desk Worker with static assets  | `apps/api`      | Public read API and the `apps/web` build served through the `ASSETS` binding                                           |
| Static desk (built, not a unit) | `apps/web`      | Vanilla TypeScript and Vite; same-origin calls to the read API                                                         |

## Codebase Map

| Path                          | Role                                                                                                                     | Platform coupling                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `apps/pipeline`               | Pipeline composition root: bindings, egress, observability, handlers                                                     | Cloudflare Workers (by design)    |
| `apps/api`                    | Desk Worker: Hono read routes and public projections                                                                     | Cloudflare Workers (by design)    |
| `apps/web`                    | Static desk: feed, item, and alert pages                                                                                 | None (browser)                    |
| `packages/contracts`          | Entities, states, queue messages, configuration, error codes, and ports (`src/ports/*`)                                  | None                              |
| `packages/core`               | Pure policy: HN and changelog scoring, clustering, idempotency keys, delivery policy, state helpers                      | None                              |
| `packages/kernel`             | Boundary parsing, clock, IDs, configuration loading, `AppError`, logger, redaction, public-link rules, console telemetry | None                              |
| `packages/ingestion`          | Tick dispatch, polling, the three source readers, observation, refresh, and sweep                                        | None                              |
| `packages/analysis`           | Triage, deep analysis, evidence collection, polish, translation, and alert drafting                                      | None                              |
| `packages/delivery`           | Delivery planning, execution, recovery, webhook notifier, Discord and Slack renderers                                    | None                              |
| `packages/prompts`            | Prompt templates, model-facing schemas, and prompt versions                                                              | None                              |
| `packages/locales`            | Reader copy, prompt writing rules, citation prefixes, and Discord labels                                                 | None                              |
| `packages/sources`            | HN Firebase, GitHub REST, and SSRF-guarded web fetch adapters                                                            | None (injected transports)        |
| `packages/llm`                | OpenRouter adapter for the `LlmClient` port                                                                              | OpenRouter API (provider adapter) |
| `packages/storage`            | D1 repositories, schema migrations, row codecs, and an in-memory implementation                                          | D1 types and SQLite dialect       |
| `packages/runtime-cloudflare` | R2 `BlobStore`, Queues `JobBus`, `SecretProvider`, queue-batch and scheduled-event decoders                              | Cloudflare bindings               |
| `tooling`                     | Shared TypeScript configs and the generated oxlint dependency boundaries (`src/boundaries.ts`)                           | None                              |
| `tools/local`                 | Local runner, model probes, and offline SQL/JSON utilities; see [tools/local/README.md](./tools/local/README.md)         | Miniflare (local only)            |
| `docs`                        | Runbook, public-link policy, ADRs, and the [archive](./docs/archive/README.md) of pre-redesign plans                     | None                              |

The repository has no unit-test suite. Static validation (`mise run check`) and the desk and API builds are the CI gate; behavior is observed by running it (see [DEVELOPMENT.md](./DEVELOPMENT.md#verifying-behavior)).

## Data and State

- **D1** holds sources and their cursors, poll slots, items, HN snapshots, revisions, analyses, budget receipts, alerts, language documents, deliveries, destinations, configuration versions, and the admin audit log. Schema changes are the ordered list in `packages/storage/src/migrations.ts`; deploys apply only the ones a database has not recorded.
- **R2** holds content-addressed blobs: normalized changelog notes and pinned analysis inputs. Rows reference them by key.
- **Queues** `q-poll`, `q-triage`, `q-deep`, and `q-deliver` carry versioned jobs (`packages/contracts/src/messages.ts`). The 900-second maximum delay and 10-message consumer batch match the SQS limits, the tighter of the two platforms; the 1 KiB envelope cap is a project constraint well below either platform's message size, which keeps jobs to IDs and wake-ups. Delivery is at least once; every consumer is idempotent.
- **Configuration** is a versioned, validated `AppConfig` row in D1. Each event reads the latest version and fails closed when none exists or it does not validate; there is no bundled fallback.
- **Item lifecycle**: `discovered → tracking → candidate → triaging → triaged_pass → analyzing → analyzed → feed_only | alerted`, with reject, skip, failure, and `archived` exits (`packages/contracts/src/states.ts`). Leases, attempts, and `next_attempt_at` drive recovery independently of queue retries.

## Source Families

### 1. Web changelogs

`packages/ingestion/src/web.ts` and `packages/ingestion/src/sections.ts`; fetched through `packages/sources/src/web.ts`.

**Current (`main`)**

- A `web_page` source names a page, an optional `fetch_url` (a Markdown twin where the site serves one), and the product surfaces to follow. Watched pages: Claude Code, ChatGPT and Codex, and Antigravity (App and CLI surfaces only), polled every 30 minutes by default.
- An unchanged page body (same content hash) ends the poll. Otherwise `splitChangelog` applies one generic heuristic: Markdown headings or bold lines whose text starts with a version mark a release, and a second-level heading without a version names the surface; if fewer than two such markers exist, it falls back to dated product lines (`2026-11-20 Codex CLI 0.171.0`).
- Each release is its own item. The cursor keeps a high-water marker per surface; a first read takes only the newest release of each surface.
- When nothing on the page splits into a followed release, nothing is published, the cursor is kept, and `pipeline.poll.unsplit` is counted. A whole page is never published as one item.

**Target / Scheduled next**: explicit lightweight per-site parsers for Claude Code, OpenAI/ChatGPT, and Antigravity, selected per source, with the generic splitter kept as the fallback for other pages.

### 2. GitHub releases

`packages/ingestion/src/github.ts`; fetched through `packages/sources/src/github.ts`.

- `release_first` lists releases (one page of 10, conditional on the stored ETag) and skips drafts. A repository with no releases falls back to tags and then to the changelog file.
- `tags_plus_changelog` lists tags (conditional on the stored ETag) and attaches the matching version section of the changelog file.
- `changelog_file` reads one file as a single item; its cursor stores the content SHA, not an HTTP validator.
- Cold start is newest-only: on a first read (no known versions) every entry after the newest is recorded as historical and never analyzed, so a new repository does not spend the day's triage budget on history.
- Changelog triage is capped per repository (and per changelog site) per day (`changelog.max_triage_per_repo_per_day`, default 3). Watched repositories are listed in the seed SQL that `tools/local/seed-sql.ts` prints; the default poll interval is 10 minutes.

### 3. Hacker News

`packages/ingestion/src/hn.ts`, `packages/core/src/scoring/hn.ts`, and `packages/ingestion/src/refresh.ts`.

- Each poll snapshots the top 30 (`hn.top_n`) plus previously seen stories still being tracked (up to `hn.track_limit`, 60): rank, points, and comments.
- Features per sample: `vp` and `vc` (points and comments per hour over the scoring window), `climb` (ranks gained over the window), `acc` (change in `vp` per hour between samples), and total points. Each is normalized against fixed reference rates (`hn.reference`) and weighted into a heat score from 0 to 100 with levels H1, H2, and H3.
- Gates: **G1 burst** (young story with enough points and either one very hot sample or consecutive hot samples), **G2 discussion** (high normalized `vc` and enough comments), **G3 sustained** (a top-10 rank for consecutive samples). Any gate moves the story to `candidate`.
- The scoring window is `hn.window_minutes` (30), but it always holds at least as many samples as the gates consult; with fewer, it reaches back to the burst gate's age limit.
- Cadence: production ticks every 30 minutes (`*/30 * * * *`), matching the default HN scoring window.
- Refresh: each tick, `refreshPublishedItems` selects published stories (`feed_only` or `alerted`) younger than `ai.refresh_max_age_hours` that gained at least `ai.refresh_min_new_comments` comments in the snapshots taken since analysis, moves them back to `triaged_pass`, and enqueues deep analysis.

Each claimed refresh increments the item revision. Deep analysis reads the previous document and prioritizes comments it did not cite. Finalization replaces the original alert documents in place with `replaceDocuments`, preserving its decision and deliveries. A retry reuses the analysis for that revision.

## Analysis and Publication

- **Triage** (`q-triage`) and **deep analysis** (`q-deep`) each win an item-state compare-and-set, a per-stage analysis lease, and a durable budget receipt before calling `LlmClient`. Inputs are pinned in R2 before the call, so a retry never re-fetches changed evidence and a replay never calls a model.
- Deep analysis writes `profile.output_lang` directly, then a polish pass repairs the prose and a text sanitizer removes leaked citations. Translations are produced only for a `send` decision, and only for the other non-English languages an enabled alert destination needs: the loop in `packages/analysis/src/deep.ts` skips `en`, and `planDeliveries` (`packages/delivery/src/finalize.ts`) plans a delivery only where a document exists in the destination's language. When `output_lang` is set to a language other than the default `en`, an English destination receives neither a document nor a delivery.
- Finalization stores the alert and its language documents atomically. With `delivery.feed_only: true` (the schema default), a `send` decision is recorded as `feed_only` and no delivery rows are created; the `q-deliver` consumer suppresses legacy jobs. With `feed_only: false`, deliveries are planned for enabled destinations and executed through the webhook notifier. The seed SQL printed by `tools/local/seed-sql.ts` sets `feed_only: false` with `profile.output_lang: zh-CN` and a matching Discord destination; it is applied by hand when a database is first initialized, not by the deploy workflow.
- Reader-facing links pass the public-link rules in `packages/kernel/src/public-links.ts`; see [docs/public-links.md](./docs/public-links.md).

## Two-Phase Cloud Portability

| Concern           | Phase 1: Cloudflare (current)   | Phase 2: AWS (target)            |
| ----------------- | ------------------------------- | -------------------------------- |
| Schedule          | Workers Cron Trigger            | EventBridge Scheduler            |
| Compute           | Workers                         | To be chosen per deployment unit |
| Work queues       | Cloudflare Queues               | SQS                              |
| Blobs             | R2                              | S3                               |
| Correctness store | D1 (SQLite)                     | RDS Postgres or DynamoDB         |
| Secrets           | Worker secrets                  | Secrets Manager                  |
| Models            | OpenRouter                      | Bedrock or OpenRouter            |
| Reader surface    | Public desk + Discord (`zh-CN`) | Internal desk + Slack (`ja`)     |

### Clean boundary today

- The domain packages `contracts`, `core`, `kernel`, `ingestion`, `analysis`, `delivery`, `prompts`, `locales`, `sources`, and `llm` import no `@cloudflare/*` package and no `cloudflare:*` module. They depend on the ports in `packages/contracts/src/ports/*` (`runtime`, `storage`, `sources`, `llm`, `notifier`), and the generated lint rules in `tooling/src/boundaries.ts` grant the `platform` capability only to `storage`, `runtime-cloudflare`, and the apps.
- Queue envelopes already fit both platforms: delay and batch size stay within the SQS limits, and the 1 KiB envelope cap sits far below either platform's message size.
- The `LlmClient` port is provider-agnostic: model routes, repair, fallback, and usage are part of the contract, not of OpenRouter.
- `packages/storage/src/memory.ts` implements the storage ports without D1 and is a reference for a second storage adapter.

### Coupling points and migration seams

| #   | Coupling point (Phase 1)                                                                                                                                                                                                                                           | AWS migration seam                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/runtime-cloudflare`: R2 `BlobStore`, Queues `JobBus`, `SecretProvider`, and the Worker queue-batch and scheduled-event decoders                                                                                                                          | Add `packages/runtime-aws` (S3, SQS, Secrets Manager, EventBridge and SQS event decoders) behind the same ports and swap it in the composition root |
| 2   | `packages/storage`: `d1.ts` and `migrations.ts` import `@cloudflare/workers-types` and use D1 `prepare`/`batch` and SQLite SQL; entities, ports, and columns name blob references `r2_key`                                                                         | Split the D1 adapter into `storage-d1`, rename `r2_key` to `blob_key` across contracts, storage, and migrations, and add an AWS storage adapter     |
| 3   | Composition roots `apps/pipeline/src/bindings.ts`, `apps/pipeline/src/worker.ts` (with `egress.ts`), and `apps/api/src/worker.ts` own the Workers handler shape, `D1Database`, R2 and Queue bindings (`BLOBS`, `*_QUEUE`), `ASSETS`, and Cloudflare DNS-over-HTTPS | New AWS entry points build the same dependency objects from AWS clients                                                                             |
| 4   | `packages/contracts/src/config.ts`: `cloudflarePipelineConfigIssue` requires every model route to use `provider === "openrouter"`, and the pipeline enforces it                                                                                                    | Move provider admission to the deployment adapter; the `LlmClient` port already accepts a Bedrock or other adapter in `packages/llm`                |
| 5   | `packages/delivery/src/render/slack.ts`: an 11-line plain-text stub over `render/text.ts`, which still prints raw `evidence_quote` lines and English-only labels                                                                                                   | Replace it with a Block Kit renderer that shares the locale packs with the Discord renderer before the AWS and Slack rollout                        |

Deployment tooling is Cloudflare-specific as well: `apps/*/wrangler.jsonc`, `.github/workflows/deploy.yml`, and the D1 migration ledger applied with `wrangler d1 execute` from `tools/local/schema-sql.ts`. Phase 2 adds parallel deployment definitions rather than editing domain code.

## Language Policy and Locale Seam

**Invariant**: code, comments, commits, repository documentation, structured logs, `AppError` codes and messages, and core defaults are English. Non-English text is never hardcoded in core packages or error paths; it enters only through a locale pack or verbatim source content (citation quotes stay in their source language).

The packs in `packages/locales` supply reader copy and error messages, site metadata, Discord labels, prompt writing rules, and citation prefixes. English (`en`) is the default for the desk and `profile.output_lang`. Simplified Chinese (`zh-CN`) and Japanese (`ja`) are also registered. The personal Cloudflare seed selects `zh-CN`, and the deploy and preview workflows build the desk in `zh-CN` unless `DESK_LOCALE` is set.

Build-time `VITE_LOCALE` sets the static desk shell, Open Graph metadata, default runtime UI locale, and preferred document language. Unset or empty values select `en`. An unsupported value fails the build. A reader can use `?lang=` to change the desk UI and request a document in that language. The API serves an available document when the requested language is missing. The article declares the language of the document served. An item page with no document links to its public source when available.

The Slack plain-text renderer still has English-only labels. Translation never targets `en`, so an English destination gets no delivery when `output_lang` is set to another language.

## Deployment and Previews

### Current (`main`)

| Environment | Deployed by                                                  | Pipeline schedule                          | Desk                                     |
| ----------- | ------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------- |
| `dev`       | Every push to `main` (or a manual `workflow_dispatch`)       | No cron; a run starts with `POST /trigger` | `ai-moves-desk-dev.fang2hou.workers.dev` |
| `prod`      | A published GitHub Release (or a manual `workflow_dispatch`) | Every 30 minutes, `*/30 * * * *`           | `moves.lineyahoo.dev` (custom domain)    |

`.github/workflows/deploy.yml` runs `mise run check`, builds the desk, dry-runs both Worker bundles, applies pending D1 schema migrations through the recorded ledger, then deploys the pipeline and the desk. Initial rows (the published configuration, sources, and destinations) are not part of `.github/workflows/deploy.yml`, which applies schema migrations only: `tools/local/seed-sql.ts` prints the seed SQL, and applying it to a database is a separate, manual initialization step. `.github/workflows/ci.yml` (job `Verify`) runs the check and both builds on every pull request. `dev` and `prod` use separate D1 databases, R2 buckets, and queues (`dev` names carry a `-dev` suffix); production consumers use `max_batch_size: 1` for `q-deep` and 10 for the other queues.

### Desk pull request previews

[Desk PR Preview](./.github/workflows/preview.yml) uploads an aliased Version URL on `ai-moves-desk-dev` for each same-repository pull request. The job uses the GitHub `preview` environment and a dedicated `CLOUDFLARE_PREVIEW_API_TOKEN` scoped to the Workers version and asset uploads required for previews. The workflow selects `--env dev` in `apps/api/wrangler.jsonc`, where `preview_urls: true` enables Version URLs and `DB` points to `ai-moves-dev` (`5bcc51a7-b879-4a33-ab9a-7a473041125b`). Previews share the dev database. The upload excludes the production Worker, domain, and database, and it runs without pipeline deployment or D1 migrations. See [Development](./DEVELOPMENT.md#desk-pull-request-previews) for the preview workflow and local verification commands.

### Read-only Desk

The Desk serves public reads and static assets. The former `/controls` UI, `/api/session` and `/api/admin/*` routes, Cloudflare Access verifier (`access.ts`), and `jose` dependency were removed. The existing D1 schema and migration history still apply.

## Invariants

- **Layer responsibilities**: domain rules live in the portable packages; adapters translate external systems to and from contracts; composition roots select adapters and own platform handler shapes.
- **Single source of truth**: `contracts` owns shared entities, states, queue messages, ports, configuration schemas, and error codes. Other packages never redeclare them.
- **Dependency direction**: domain packages depend only on `contracts`, `kernel`, `core`, `prompts`, and `locales` as allowed by `tooling/src/boundaries.ts`; they never import adapter packages, `@cloudflare/*`, AWS SDKs, provider SDKs, or `cloudflare:*` modules.
- **External API access**: raw network access is confined to the source, LLM, and notifier adapters and the pipeline's egress module. Other code receives injected ports.
- **State ownership**: the correctness store (D1 today) is authoritative; queues carry IDs and wake-ups only, and every consumer is idempotent under at-least-once delivery.
- **Portability**: platform APIs, SQL dialect, provider model IDs, and provider admission rules stay behind adapters, composition roots, or configuration. Queue envelopes stay within the tighter of the Cloudflare Queues and SQS limits.
- **Language neutrality**: core code, logs, error codes, and defaults are English; reader-facing language comes only from locale packs and verbatim source quotes.

## Cross-Cutting Concerns

- Failures are `AppError` values with a code from `@ai-moves/contracts/errors`; each code has exactly one kind (`retryable`, `permanent`, `ambiguous`, ...), and consumers branch on the kind.
- Structured logs pass the kernel redactor before reaching telemetry. Error logs carry the code, never the original message, prompt, URL, or credential. Signals are listed in the [operations runbook](./docs/b4-operations-runbook.md).
- An ambiguous outcome (`OUTCOME_UNKNOWN`) is never retried automatically: a delivery that might have been sent stays `unknown`.

## Known Limitations on `main`

- On a deployed Worker, `PINNED_WEB.fetchPinned` (`apps/pipeline/src/egress.ts`) fetches by hostname after the address check, because a Worker cannot open a socket to a chosen address. It relies on the platform refusing private addresses; only the local runner pins the connection.
- Delivery-transition telemetry (`pipeline.delivery.transition`, `pipeline.delivery_transition`) is emitted only when the feed-only path suppresses a legacy job; a normal webhook delivery emits none (see the [runbook](./docs/b4-operations-runbook.md#delivery-outcomes)).
- Web changelog splitting is one generic heuristic, the Slack renderer is a stub, and an English destination gets nothing while `output_lang` is set to another language (see the sections above).

## Decisions and History

- [ADR-0001](./docs/adr/0001-b1-package-boundaries.md), [ADR-0002](./docs/adr/0002-b2-durable-work.md), and [ADR-0003](./docs/adr/0003-initial-feed-only-rollout.md) record earlier decisions; ADR-0001 and ADR-0003 carry dated notes where `main` has since moved.
- Pre-redesign plans and acceptance records are in [docs/archive/](./docs/archive/README.md). Code comments that cite "architecture X.Y" or `docs/architecture-v1.md` refer to `docs/archive/architecture-v1.md`.
- Changing an invariant above requires the owner's approval in the pull request that changes it.

# Architecture

AI News Tracker watches documentation changelogs, GitHub releases, the Hacker News front page, and authenticated MCP submissions. It scores Hacker News stories with deterministic rules and a batched relevance check, runs model analysis on qualifying stories, reviewed submissions, and every timely watched changelog release, and publishes the result to a public read-only desk alongside Discord webhooks on Cloudflare (plus Slack via the shared webhook/Block Kit renderer and AWS Lambda entry). Domain logic lives in portable packages; Cloudflare, AWS, and provider details live in adapters and composition roots, so the system can run on either cloud without rewriting domain code.

Keep this document short and stable: revisit it when the architecture changes, not on routine edits. It names modules and states what must remain true; behavior, limits, and operating detail live in the package READMEs and the pages under `docs/` that each section links.

## System Overview

```text
cron tick ──► dispatch due sources ──► q-poll ──► poll: HN | GitHub | web changelog
                                                     │  items, snapshots, cursors (D1); notes (R2)
                                                     ▼  changelog release or `score` submission (qualified HN and `publish` submissions go directly to q-deep)
                                      q-triage ──► review (`score` submissions) / pass-through (changelogs) ──► q-deep ──► deep analysis,
                                                                                                                           polish, translation
                                                                                                                               │
                                                    alert + language documents (D1) ◄──────────────────────────────────────────┘
                                                         │                     │
                                                         ▼                     ▼
                                           public desk (apps/api + apps/web)   q-deliver ──► webhook (Discord; Slack on AWS)
```

On AWS the same pipeline runs as Lambda functions: an EventBridge rule invokes `tick`, SQS invokes `queue`, and DynamoDB, S3, and SSM Parameter Store stand in for D1, R2, and Worker secrets (see [docs/portability.md](./docs/portability.md)).

The same tick also runs the refresh pass for published Hacker News stories and the sweep that recovers stalled work. D1 is the correctness store: every queue message is a wake-up that names durable rows, and the sweep can rediscover any work whose message was lost.

| Deployment unit                 | Source          | Runs                                                                                                                                                             |
| ------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline Worker                 | `apps/pipeline` | `scheduled` (tick: dispatch, refresh, sweep), `queue` (poll, triage, deep, deliver), a token-gated `POST /trigger`, and the token-gated MCP endpoint `POST /mcp` |
| Desk Worker with static assets  | `apps/api`      | Public read API and the `apps/web` build served through the `ASSETS` binding                                                                                     |
| Static desk (built, not a unit) | `apps/web`      | Vanilla TypeScript and Vite; same-origin calls to the read API                                                                                                   |

## Codebase Map

| Module                        | Role                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/pipeline`               | Pipeline composition: the platform-neutral `pipeline.ts`, the Worker entry (bindings, egress, handlers), and the Lambda entry under `src/aws`           |
| `apps/api`                    | Desk read API: Hono routes and public projections, served by a Worker with static assets or by a Lambda function                                        |
| `apps/web`                    | Static desk: feed, item, alert, heat, and optional submissions pages (strict CSP with Zod jitless validation)                                           |
| `packages/contracts`          | Entities, states, queue messages, configuration, error codes, and ports                                                                                 |
| `packages/core`               | Pure policy: HN scoring, clustering, idempotency keys, delivery policy, state helpers                                                                   |
| `packages/kernel`             | Boundary parsing, clock, IDs, configuration loading, `AppError`, logger, redaction, public-link rules, console telemetry                                |
| `packages/ingestion`          | Tick dispatch, polling, the three source readers, observation, submissions, refresh, and sweep                                                          |
| `packages/analysis`           | Submission review, deep analysis, evidence collection, polish, translation, and alert drafting                                                          |
| `packages/delivery`           | Delivery planning, execution, recovery, webhook notifier, Discord and Slack renderers                                                                   |
| `packages/prompts`            | Prompt templates, model-facing schemas, and prompt versions                                                                                             |
| `packages/locales`            | Reader copy, prompt writing rules, citation prefixes, and Discord and Slack labels                                                                      |
| `packages/sources`            | HN Firebase, GitHub REST, and SSRF-guarded web fetch adapters                                                                                           |
| `packages/llm`                | Charm Hyper, OpenRouter, and Claude in Amazon Bedrock adapters for the `LlmClient` port                                                                 |
| `packages/storage`            | In-memory implementation of the storage ports and the shared lease, alert-document, and send-interval rules                                             |
| `packages/storage-d1`         | D1 repositories, schema migrations, and row codecs; maps the domain `blob_key` to the D1 column `r2_key`                                                |
| `packages/storage-dynamodb`   | DynamoDB repositories on one table with three overloaded indexes, reached through an injected client                                                    |
| `packages/runtime-cloudflare` | R2 `BlobStore`, Queues `JobBus`, `SecretProvider`, queue-batch and scheduled-event decoders                                                             |
| `packages/runtime-aws`        | S3 `BlobStore`, SQS `JobBus`, SSM `SecretProvider`, Lambda event decoders, and the SigV4 signer they share                                              |
| `tooling`                     | Shared TypeScript configs and the generated oxlint dependency boundaries                                                                                |
| `tools/local`                 | Local runner, model probes, and offline SQL, JSON, and DynamoDB utilities; see its [README](./tools/local/README.md)                                    |
| `docs`                        | Runbook, deployment, portability, rename migration runbook, public-link policy, ADRs, and the [archive](./docs/archive/README.md) of pre-redesign plans |

Platform coupling per module is listed in [docs/portability.md](./docs/portability.md#platform-coupling-by-module).

## Data and State

- **D1** holds sources and their cursors, poll slots, items, HN snapshots, revisions, analyses, alerts, language documents, deliveries, destinations, configuration versions, and the admin audit log. Schema changes are an ordered list of migrations; a deploy applies only the ones a database has not recorded (see the [D1 adapter README](./packages/storage-d1/README.md)).
- **R2** holds content-addressed blobs: normalized changelog notes and pinned analysis inputs. Revisions and analyses reference them by `blob_key`.
- **Queues** `q-poll`, `q-triage`, `q-deep`, and `q-deliver` carry versioned jobs. The 900-second maximum delay and 10-message consumer batch match the SQS limits, the tighter of the two platforms; the 1 KiB envelope cap is a project constraint well below either platform's message size, which keeps jobs to IDs and wake-ups. Delivery is at least once; every consumer is idempotent.
- **Configuration** is a versioned, validated `AppConfig` row in D1. Each event reads the latest version and fails closed when none exists or it does not validate; there is no bundled fallback.
- **Alert kinds**: an item has one `new` alert. A Hacker News refresh or a changelog notes revision rereads the item and replaces that alert's documents in place, keeping its decision and deliveries, so it is never pushed twice. Only a forced submission mints an `update` alert, keyed by the item revision it was forced at; `delivery.max_updates_per_item` caps how many of those are sent.
- **Item lifecycle**: `discovered → tracking → candidate → triaging → triaged_pass → analyzing → analyzed → feed_only | alerted`, with qualified HN stories and `publish` submissions moving directly to `triaged_pass`, forced submissions moving from `triaged_reject`, `failed_analysis`, or `feed_only` to `triaged_pass`, re-reviewed submissions returning from `triaged_reject` to `candidate`, and reject, skip, failure, and `archived` exits. Leases, attempts, and `next_attempt_at` drive recovery independently of queue retries.

## Source Families

Each family's reader, cursor rules, and cadence are in the [ingestion README](./packages/ingestion/README.md#source-families).

### 1. Web changelogs

[Web changelogs](./packages/ingestion/README.md#web-changelogs): page parsers, per-surface cursors, and one item per release.

### 2. GitHub releases

[GitHub releases](./packages/ingestion/README.md#github-releases): release strategies, newest-only cold start, and release freshness.

### 3. Hacker News

[Hacker News](./packages/ingestion/README.md#hacker-news) snapshots and [refresh](./packages/ingestion/README.md#refresh) are in the ingestion README. The heat score and gates are in the [core README](./packages/core/README.md#hacker-news-scoring).

Each poll derives one `hn.activity` factor from measured vote velocities in the live ranked batch. That factor scales score reference rates and gate volume floors for both the current sample and its prior heats. The poll uses existing snapshots and keeps the measured features in the score.

Each poll also asks the model, in one batched call through an injected judge, how useful every not-yet-judged story is to engineers at a financial company who adopt new technology eagerly: `core` for AI itself (models, agent harnesses and AI coding tools, AI for productivity and in company work, how AI is changing work, teams, companies, and society, and high-quality research on it), `adjacent` for other engineering they would still want (software engineering and developer tooling including notable new features, AI research, security incidents with engineering substance or wide consequences, industry or market shifts), and `unrelated` for stories with nothing to learn, such as personal or gossip angles on people and companies. The label is stored in the score, raises or lowers that story's heat, and lowers or raises its gate volume floors. While `hn.relevance.block_unrelated` is true (the default), an `unrelated` story is still scored but never passes a gate, however hot it runs. A verdict is stored with its prompt version and asked again under a newer one. While the block is on, an unjudged story (a failed or timed-out call) also waits for a verdict before it can qualify.

### 4. Submissions

Signed-in readers send markdown through the pipeline's MCP endpoint (`submit_item`) and inspect or manage submissions with `get_submission`, `list_submissions`, `force_publish`, and `rereview_submission` (see [MCP submissions](./DEVELOPMENT.md#mcp-submissions)). Each submission becomes a `submission` item under one never-polled source, one item per canonical source URL, with the markdown as its revision and the verified submitter in its score. `score` submissions go through the AI reviewer; `publish` submissions go straight to deep analysis. A submission that reached deep analysis is pushed in either mode, subject to normal delivery checks. The card names the submitter. The platform entry point supplies the identity: a bearer token on Cloudflare, or proxy-verified headers on AWS. See the [ingestion README](./packages/ingestion/README.md).

## Analysis and Publication

Claims, replay, normalized wording-based citation verification, and language documents are in the [analysis README](./packages/analysis/README.md). Finalization, [publication](./packages/delivery/README.md#publication), quiet-hours deferral, pacing, and sending are in the [delivery README](./packages/delivery/README.md). Reader-facing links follow the rules in [docs/public-links.md](./docs/public-links.md).

The primary analysis stages share one model provider (`hyper`, `openrouter`, or on AWS Lambda `bedrock` / `bedrock-runtime`). An optional stage-level `fallback_routes` list can select another provider after a qualifying failure. The shared pipeline validates both the primary and fallback routes against the deployment's adapters. See the [LLM adapter routing rules](./packages/llm/README.md#cross-provider-fallback).

Daily AI and delivery budgets were removed. HN gates qualify stories for analysis, the AI reviewer qualifies `score` submissions, and every timely watched changelog release is analyzed. The HN push thresholds and delivery policy govern notifications. Operators can pause AI with `ai.enabled: false` or notifications with `delivery.paused: true`. See the [operations runbook](./docs/b4-operations-runbook.md#pause-ai-or-notifications).

## Two-Phase Cloud Portability

Phase 1 runs on Cloudflare and Phase 2 targets AWS. The concern-by-concern mapping, the clean boundary today, and each coupling point with its migration seam are in [docs/portability.md](./docs/portability.md).

## Language Policy and Locale Seam

**Invariant**: code, comments, commits, repository documentation, structured logs, `AppError` codes and messages, and core defaults are English. Non-English text is never hardcoded in core packages or error paths; it enters only through a locale pack or verbatim source content (citation quotes stay in their source language).

The packs in `packages/locales` supply reader copy, number and unit formatters, error messages, site metadata, Discord and Slack labels, prompt writing rules, and citation prefixes. English (`en`) is the default for the desk and `profile.output_lang`. Simplified Chinese (`zh-CN`) and Japanese (`ja`) are also registered. The personal Cloudflare seed selects `zh-CN`, and the deploy and preview workflows build the desk in `zh-CN` unless `DESK_LOCALE` is set.

Build-time `VITE_LOCALE` sets the static desk shell, Open Graph metadata, default runtime UI locale, and preferred document language. Unset or empty values select `en`. An unsupported value fails the build. A reader can use `?lang=` to change the desk UI and request a document in that language. The API serves an available document when the requested language is missing. The article declares the language of the document served. An item page with no document links to its public source when available.

The Discord and Slack renderers take their labels from the pack of the document's language. Translation never targets `en`, so an English destination gets no delivery when `output_lang` is set to another language.

## Deployment and Previews

The `dev` and `prod` environments, what a deploy applies, and desk pull request previews are in [docs/deployment.md](./docs/deployment.md). Live Cloudflare Workers, D1 databases, and R2 buckets still use their legacy Phase 1 `ai-moves-*` resource names pending the infrastructure rename cutover in [docs/rename-migration.md](./docs/rename-migration.md). The deploy procedure is in [DEVELOPMENT.md](./DEVELOPMENT.md#deployment).

## Invariants

- **Layer responsibilities**: domain rules live in the portable packages; adapters translate external systems to and from contracts; composition roots select adapters and own platform handler shapes.
- **Single source of truth**: `contracts` owns shared entities, states, queue messages, ports, configuration schemas, and error codes. Other packages never redeclare them.
- **Dependency direction**: domain packages depend only on `contracts`, `kernel`, `core`, `prompts`, and `locales`, as the generated lint boundaries allow; they never import adapter packages, `@cloudflare/*`, AWS SDKs, provider SDKs, or `cloudflare:*` modules.
- **External API access**: raw network access is confined to the source, LLM, and notifier adapters and the pipeline's egress module. Other code receives injected ports.
- **State ownership**: the correctness store (D1 today) is authoritative; queues carry IDs and wake-ups only, and every consumer is idempotent under at-least-once delivery.
- **Portability**: platform APIs, SQL dialect, provider model IDs, and provider admission rules stay behind adapters, composition roots, or configuration. Queue envelopes stay within the tighter of the Cloudflare Queues and SQS limits.
- **Language neutrality**: core code, logs, error codes, and defaults are English; reader-facing language comes only from locale packs and verbatim source quotes.

## Cross-Cutting Concerns

- Failures are `AppError` values with a code from `@ai-news-tracker/contracts/errors`; each code has exactly one kind (`retryable`, `permanent`, `ambiguous`, ...), and consumers branch on the kind.
- Structured logs pass the kernel redactor before reaching telemetry. Error logs carry the code, never the original message, prompt, URL, or credential. Signals are listed in the [operations runbook](./docs/b4-operations-runbook.md).
- An ambiguous outcome (`OUTCOME_UNKNOWN`) is never retried automatically: a delivery that might have been sent stays `unknown`.

## Known Limitations on `main`

- On a deployed Cloudflare Worker, `PINNED_WEB.fetchPinned` fetches by hostname after the address check because a Worker cannot open a socket to a chosen address, relying on the platform to refuse private addresses. Both the local runner (`tools/local/run.ts`) and AWS Lambda (`apps/pipeline/src/aws/egress.ts`) pin the socket to the checked address (see the [sources README](./packages/sources/README.md)).
- Deliveries emit no transition telemetry; read the delivery row (see the [runbook](./docs/b4-operations-runbook.md#delivery-outcomes)).
- An English destination gets nothing while `output_lang` is set to another language (see [Language Policy and Locale Seam](#language-policy-and-locale-seam) and the [delivery README](./packages/delivery/README.md)).

## Decisions and History

- [ADR-0001](./docs/adr/0001-b1-package-boundaries.md), [ADR-0002](./docs/adr/0002-b2-durable-work.md), and [ADR-0003](./docs/adr/0003-initial-feed-only-rollout.md) record earlier decisions; all three carry dated notes where `main` has since moved.
- Pre-redesign plans and acceptance records are in [docs/archive/](./docs/archive/README.md). Code comments that cite "architecture X.Y" or `docs/architecture-v1.md` refer to `docs/archive/architecture-v1.md`.
- Changing an invariant above requires the owner's approval in the pull request that changes it.

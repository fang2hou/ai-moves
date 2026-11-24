# Architecture

AI Moves is a monorepo for a small monitoring pipeline that turns selected external activity into readable documents and short Discord cards. Domain contracts, deterministic infrastructure, platform adapters, and deployable assembly roots are separated so providers and runtimes can change without rewriting domain logic.

## Overview

Two Workers run on Cloudflare.

- `apps/pipeline` is woken by an hourly cron. A tick dispatches the sources whose interval is due, sends published Hacker News stories back for a refresh, and sweeps stale work (`apps/pipeline/src/worker.ts`). Four queues carry the work on: `q-poll`, `q-triage`, `q-deep` and `q-deliver`. Polling and scoring use no model. Triage, deep analysis and the polish pass call OpenRouter, and the program, not the model, decides what is sent (`packages/core/src/policy/delivery.ts`). D1 is the correctness store; R2 holds content-addressed blobs such as a changelog revision or the prepared input of a model call.
- `apps/api` is a Hono Worker. It serves the desk's API from the same D1 database and the pages built from `apps/web` as static assets (`apps/api/src/app.ts`). Reads are public. Only `/api/admin/*` and `/api/session` check a Cloudflare Access assertion, and they fail closed when the `ACCESS_*` bindings are absent (`apps/api/src/access.ts`).

The pipeline reads the newest configuration version from D1 at the start of every invocation and has no bundled fallback (`loadWork` in `apps/pipeline/src/worker.ts`). Model routes, budgets, the watchlist and the delivery switch all live in that configuration (`packages/contracts/src/config.ts`).

## Codebase Map

| Package                                 | Role                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`                    | Entities, state models, queue messages, ports, the configuration schema, and error codes.                                  |
| `packages/kernel`                       | Clocks, IDs, boundary parsing, configuration loading, errors, logging with redaction, timeouts, and the public-link rules. |
| `packages/core`                         | Deterministic Hacker News and changelog scoring, the send policy, state guards, and idempotency keys.                      |
| `packages/prompts`                      | Model templates, output schemas, and prompt versions.                                                                      |
| `packages/storage`                      | The D1 adapter, its migrations and its row codecs.                                                                         |
| `packages/sources`                      | The Hacker News, GitHub, and web adapters.                                                                                 |
| `packages/llm`                          | The OpenRouter adapter.                                                                                                    |
| `packages/ingestion`                    | Poll dispatch, observation, the refresh pass, and recovery of stale work.                                                  |
| `packages/analysis`                     | Triage, deep analysis, polish, translation, and finalization into an alert document.                                       |
| `packages/delivery`                     | Delivery planning, execution, and recovery, and the Discord and Slack renderers.                                           |
| `packages/runtime-cloudflare`           | Queue, R2, and secret bindings behind the ports.                                                                           |
| `apps/pipeline`, `apps/api`, `apps/web` | The two Workers and the pages of the desk.                                                                                 |
| `tooling`                               | Shared TypeScript configuration and the generated lint boundaries.                                                         |
| `tools/local`                           | The local demo, the paid probes, and the scripts that render SQL for a deployment.                                         |

## Invariants

- **Layer responsibilities**: domain rules belong in pure component packages; adapters translate external systems into contracts.
- **Single source of truth**: `contracts` owns shared entities, states, queue messages, ports, the configuration schema, and error codes. Other packages must not redeclare them.
- **Dependency direction**: a package imports only what `tooling/src/boundaries.ts` allows. Component packages depend on contracts, kernel, and domain packages, never on adapter packages, provider SDKs, or `cloudflare:*` modules.
- **Capabilities**: Worker bindings (the `platform` capability) are confined to `storage`, `runtime-cloudflare` and the two Workers. Plain network calls (the `raw-fetch` capability) are confined to `sources`, `llm`, the notifiers of `delivery`, and `apps/pipeline/src/egress.ts`.
- **External API access**: every other package receives injected ports for the network, the clock, and ID generation.
- **State ownership**: D1 is the correctness store; queues carry IDs and wake-up signals, not authoritative business state.
- **Administrative boundary**: the API Worker binds only its database, its static assets, and the `ACCESS_*` variables (`apps/api/src/worker.ts`). It never holds a provider or notifier credential, and an unverified identity is never an administrator.
- **Integration boundaries**: adapters own provider payload validation and mapping; downstream code receives only contract types.
- **Configuration**: configuration enters only through `loadAppConfig` and `loadRuntimeEnv` (`packages/kernel/src/config.ts`). The pipeline refuses a version that names a provider other than OpenRouter (`cloudflarePipelineConfigIssue` in `packages/contracts/src/config.ts`).
- **Portability**: platform APIs, SQL dialect features, and provider-specific model IDs stay behind adapters or in the configuration.

## Cross-Cutting Concerns

Failures are represented by `AppError` and shared error codes. Logs go through the kernel logger, which redacts what it writes (`packages/kernel/src/logger.ts`). Queue consumers must be idempotent because delivery is at least once.

Web egress is a checked fetch, not a pinned connection. The fetcher requires HTTPS on port 443, rejects IP literals and denied domains, and accepts only public DNS answers (`packages/sources/src/web.ts`). On Cloudflare the lookup goes over DNS-over-HTTPS and the request then goes out by hostname, because a Worker cannot open a socket to a chosen address (`apps/pipeline/src/egress.ts`). Only the local demo connects to the validated address (`tools/local/run.ts`).

## Decisions

Significant architecture decisions belong in `docs/adr/` using the shared ADR structure. Update or supersede a decision explicitly rather than silently violating it.

| Decision                                                             | Subject                                            | State                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| [ADR-0001](./docs/adr/0001-b1-package-boundaries.md)                 | Freeze the B1 package boundaries                   | Accepted; its validation bullet is superseded by ADR-0008 |
| [ADR-0002](./docs/adr/0002-b2-durable-work.md)                       | Durable B2 work and read boundaries                | Accepted; amended by ADR-0006                             |
| [ADR-0003](./docs/adr/0003-initial-feed-only-rollout.md)             | Initial feed-only rollout                          | Superseded by ADR-0005                                    |
| [ADR-0004](./docs/adr/0004-public-desk-access-for-administration.md) | A public desk, with Access for administration only | Accepted                                                  |
| [ADR-0005](./docs/adr/0005-live-discord-delivery.md)                 | Live Discord delivery                              | Accepted                                                  |
| [ADR-0006](./docs/adr/0006-living-documents-and-the-refresh-pass.md) | Living documents and the refresh pass              | Accepted                                                  |
| [ADR-0007](./docs/adr/0007-hourly-cron-and-manual-trigger.md)        | An hourly cron and a manual trigger                | Accepted                                                  |
| [ADR-0008](./docs/adr/0008-static-checks-instead-of-a-test-suite.md) | Static checks instead of a test suite              | Accepted                                                  |

The v1 plan, the implementation contracts, and the acceptance documents are kept in [`docs/archive`](./docs/archive/README.md). They are history. The configuration defaults still cite the section numbers of the plan (`packages/contracts/src/config.ts`); nothing else in them describes the product that runs.

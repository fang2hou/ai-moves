# Portability

Phase 1 runs on Cloudflare and Phase 2 targets AWS. This page holds the concern-by-concern mapping, the boundary that keeps the domain portable today, and each Cloudflare coupling point with its migration seam. The rule itself is the portability invariant in [ARCHITECTURE.md](../ARCHITECTURE.md#invariants).

## Two-Phase Mapping

| Concern           | Phase 1: Cloudflare (current)   | Phase 2: AWS (target)            |
| ----------------- | ------------------------------- | -------------------------------- |
| Schedule          | Workers Cron Trigger            | EventBridge Scheduler            |
| Compute           | Workers                         | To be chosen per deployment unit |
| Work queues       | Cloudflare Queues               | SQS                              |
| Blobs             | R2                              | S3                               |
| Correctness store | D1 (SQLite)                     | DynamoDB                         |
| Secrets           | Worker secrets                  | SSM Parameter Store              |
| Models            | OpenRouter                      | Bedrock or OpenRouter            |
| Reader surface    | Public desk + Discord (`zh-CN`) | Internal desk + Slack (`ja`)     |

## Clean boundary today

- The domain packages `contracts`, `core`, `kernel`, `ingestion`, `analysis`, `delivery`, `prompts`, `locales`, `sources`, `llm`, and `storage` import no `@cloudflare/*` package and no `cloudflare:*` module. They depend on the ports in `packages/contracts/src/ports/*` (`runtime`, `storage`, `sources`, `llm`, `notifier`), and the generated lint rules in `tooling/src/boundaries.ts` grant the `platform` capability only to `storage-d1`, `runtime-cloudflare`, and the apps.
- Queue envelopes already fit both platforms: delay and batch size stay within the SQS limits, and the 1 KiB envelope cap sits far below either platform's message size.
- The `LlmClient` port is provider-agnostic: model routes, repair, fallback, and usage are part of the contract, not of OpenRouter.
- `packages/storage/src/memory.ts` implements the storage ports without D1 and is a reference for a second storage adapter; `packages/storage/src/rules.ts` holds the validation every adapter shares.
- `@ai-moves/contracts/config` validates only portable invariants (`pipelineConfigIssue`); which model providers a deployment admits is decided by its composition root.
- Entities and ports name blob references `blob_key`, independent of R2 or S3.

## Coupling points and migration seams

| #   | Coupling point (Phase 1)                                                                                                                                                                                                                                                                                                       | AWS migration seam                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/runtime-cloudflare`: R2 `BlobStore`, Queues `JobBus`, `SecretProvider`, and the Worker queue-batch and scheduled-event decoders                                                                                                                                                                                      | **Completed:** `packages/runtime-aws` implements S3, SQS, SSM Parameter Store, and the Lambda SQS and EventBridge decoders behind the same ports, over `fetch` with its own SigV4 signer because provider SDKs are banned. Remaining: wiring them into an AWS entry point |
| 2   | `packages/storage-d1`: `d1.ts` and `migrations.ts` import `@cloudflare/workers-types` and use D1 `prepare`/`batch` and SQLite SQL; the SQLite column for blob references is still `r2_key`                                                                                                                                     | **Completed:** the D1 adapter lives in `packages/storage-d1`, and `packages/storage-dynamodb` implements the same ports on one DynamoDB table; contracts, ports, and portable packages name the field `blob_key`, mapped to `r2_key` only in `storage-d1`                 |
| 3   | Composition roots `apps/pipeline/src/bindings.ts`, `apps/pipeline/src/worker.ts` (with `egress.ts`), and `apps/api/src/worker.ts` own the Workers handler shape around the platform-neutral `apps/pipeline/src/pipeline.ts`, `D1Database`, R2 and Queue bindings (`BLOBS`, `*_QUEUE`), `ASSETS`, and Cloudflare DNS-over-HTTPS | New AWS entry points build the same dependency objects from AWS clients                                                                                                                                                                                                   |
| 4   | `apps/pipeline/src/pipeline.ts`: `deploymentConfigIssue` admits only `provider === "openrouter"` routes before calling the portable `pipelineConfigIssue`                                                                                                                                                                      | **Completed:** provider admission moved from `contracts` into the Cloudflare composition root; an AWS entry point admits its own providers, and the `LlmClient` port already accepts a Bedrock or other adapter in `packages/llm`                                         |
| 5   | `packages/delivery/src/render/slack.ts`: a Block Kit renderer for Slack incoming webhooks                                                                                                                                                                                                                                      | **Completed:** header, source context, summary, grouped points, and link buttons, with labels from the locale packs shared with the Discord renderer; evidence quotes are never rendered. Remaining: a send to a real Slack workspace during the AWS rollout              |

Deployment tooling is Cloudflare-specific as well: `apps/*/wrangler.jsonc`, `.github/workflows/deploy.yml`, and the D1 migration ledger applied with `wrangler d1 execute` from `tools/local/schema-sql.ts`. Phase 2 adds parallel deployment definitions rather than editing domain code.

## Platform coupling by module

| Module                        | Platform coupling                 |
| ----------------------------- | --------------------------------- |
| `apps/pipeline`               | Cloudflare Workers (by design)    |
| `apps/api`                    | Cloudflare Workers (by design)    |
| `apps/web`                    | None (browser)                    |
| `packages/contracts`          | None                              |
| `packages/core`               | None                              |
| `packages/kernel`             | None                              |
| `packages/ingestion`          | None                              |
| `packages/analysis`           | None                              |
| `packages/delivery`           | None                              |
| `packages/prompts`            | None                              |
| `packages/locales`            | None                              |
| `packages/sources`            | None (injected transports)        |
| `packages/llm`                | OpenRouter API (provider adapter) |
| `packages/storage`            | None                              |
| `packages/storage-d1`         | D1 types and SQLite dialect       |
| `packages/storage-dynamodb`   | None (injected DynamoDB client)   |
| `packages/runtime-aws`        | AWS APIs over injected `fetch`    |
| `packages/runtime-cloudflare` | Cloudflare bindings               |
| `tooling`                     | None                              |
| `tools/local`                 | Miniflare (local only)            |
| `docs`                        | None                              |

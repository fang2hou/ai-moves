<div align="center">

# AI News Tracker

Watches AI tooling changelogs, GitHub releases, Hacker News, and reader submissions, analyzes what qualifies, and publishes a public reading desk alongside webhook alerts.

</div>

AI News Tracker (`ai-news-tracker`) polls web changelogs, GitHub releases, and Hacker News while accepting authenticated MCP submissions (`POST /mcp`). Hacker News stories qualify through activity-scaled momentum gates and a batched relevance check, `score` submissions pass through an AI reviewer, and watched changelog releases pass through `q-triage` directly to deep analysis with no model review call. Each published item gets one article on the public desk (with Hacker News refreshes and changelog revisions updating its alert documents in place) and a Discord notification on Cloudflare when delivery policy permits; the shared webhook renderer and AWS adapters also support Slack. Phase 1 runs on Cloudflare Workers, D1, R2, and Queues, alongside parallel AWS adapters (Lambda, DynamoDB, S3, SQS, and SSM) in the same monorepo.

## Getting started

Requires [mise](https://mise.jdx.dev/) on macOS or Linux. Runtime and tool versions are pinned in `mise.toml`.

```bash
mise install
pnpm install --frozen-lockfile
mise run check
mise run build
```

## Features

- **Four ingestion paths**: documentation changelogs split into one item per release, GitHub releases with ETag caching and newest-only cold start, Hacker News top-30 momentum scoring with batched relevance classification (`core`, `adjacent`, `unrelated`), and authenticated MCP reader submissions (`submit_item`, `get_submission`, `list_submissions`, `force_publish`, `rereview_submission`).
- **Model routing and citation verification**: Charm Hyper primary routes with cross-provider `fallback_routes` to OpenRouter (plus Claude on Amazon Bedrock in AWS Lambda), normalized wording-based citation matching, and pluggable `en`, `zh-CN`, and `ja` locale packs.
- **Durable at-least-once processing**: D1 (or DynamoDB on AWS) is the authoritative correctness store, queues (`q-poll`, `q-triage`, `q-deep`, `q-deliver`) carry bounded wake-ups, and a sweep recovers stalled leases and deferred sends.
- **Always-live delivery with quiet hours and pacing**: no daily budget caps; alerts found during quiet hours or within the send interval are deferred rather than dropped, then sent via Discord on Cloudflare (plus Slack via the shared renderer and AWS deployment).
- **Public, read-only desk**: `apps/api` and `apps/web` serve `/`, `/items/:id`, `/alerts/:id`, `/heat`, and optional `/submissions` behind strict security headers and Zod jitless validation.
- **Portable boundaries**: shared contracts and generated `oxlint` dependency rules keep platform code out of domain packages.

## Documentation

| Document                                                         | Covers                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [ARCHITECTURE.md](./ARCHITECTURE.md)                             | System diagram, module map, source families, invariants, and locale seam             |
| [DEVELOPMENT.md](./DEVELOPMENT.md)                               | Toolchain setup, commands, MCP and AWS Lambda entry points, and deployment workflow  |
| [CONTRIBUTING.md](./CONTRIBUTING.md)                             | Pull request workflow, review checklist, and Conventional Commit rules               |
| [docs/deployment.md](./docs/deployment.md)                       | Cloudflare `dev` and `prod` environments, legacy Phase 1 names, and Desk PR previews |
| [docs/b4-operations-runbook.md](./docs/b4-operations-runbook.md) | Queue settings, pausing AI or delivery, signals, and incident diagnosis              |
| [docs/rename-migration.md](./docs/rename-migration.md)           | Zero-data-loss cutover from `fang2hou/ai-moves` and `ai-moves-*` resources           |
| [docs/portability.md](./docs/portability.md)                     | Two-phase Cloudflare-to-AWS mapping and coupling seams                               |
| [docs/public-links.md](./docs/public-links.md)                   | URL validation and withholding rules for stored and published links                  |
| [tools/local/README.md](./tools/local/README.md)                 | Local Miniflare runner, model probes, and offline SQL/DynamoDB/Discord utilities     |

Run `mise run` to list all project tasks. The repository has no unit-test suite; to observe the pipeline end to end locally, use the Miniflare runner in [tools/local](./tools/local/README.md), which calls the live model provider.

## License

[MIT](./LICENSE)

<div align="center">

# AI News Tracker

Tracks AI coding-tool changelogs, GitHub releases, Hacker News breakouts, and reader submissions, then publishes a public reading desk with Discord and Slack alerts.

[Quick Start](#-quick-start) | [Features](#-features) | [Development](#-development)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020.svg?style=flat-square)](https://developers.cloudflare.com/workers/)
[![Node.js 26](https://img.shields.io/badge/Node.js-26-339933.svg?style=flat-square)](./mise.toml)

</div>

AI News Tracker (`ai-news-tracker`) helps engineers keep up with fast-moving AI releases without watching every feed by hand. It monitors AI coding-tool changelogs, GitHub releases, Hacker News momentum breakouts, and reader submissions over Model Context Protocol (MCP), then publishes verified summaries to the public read-only reading desk at [moves.lineyahoo.dev](https://moves.lineyahoo.dev) alongside concise Discord and Slack alert cards. Phase 1 runs on Cloudflare Workers, D1, R2, and Queues, with parallel AWS Lambda, DynamoDB, S3, SQS, and SSM adapters in the same monorepo.

## 🚀 Quick Start

Install [mise](https://mise.jdx.dev/) on macOS or Linux. Runtime and CLI versions are pinned in `mise.toml`.

```bash
mise install
pnpm install --frozen-lockfile
mise run check
mise run build
```

## ✨ Features

### `1` Four Ingestion Paths

The pipeline watches web documentation changelogs (split into one item per release), GitHub releases with ETag caching and newest-only cold start, and Hacker News momentum breakouts with batched relevance classification (`core`, `adjacent`, `unrelated`). Authenticated readers can also submit, inspect, re-review, or force-publish items through the MCP endpoint at `POST /mcp`.

### `2` Model Routing and Citation Checks

Analysis routes through Charm Hyper or OpenRouter on Cloudflare (plus Claude on Amazon Bedrock in AWS Lambda), with optional cross-provider `fallback_routes` after qualifying failures. Every generated claim is checked against normalized source wording, and pluggable locale packs (`en`, `zh-CN`, and `ja`) supply reader copy, alert labels, and writing rules.

### `3` Durable Processing

D1 on Cloudflare (or DynamoDB on AWS) is the authoritative correctness store, while R2 (or S3) holds content-addressed changelog notes and analysis inputs. Queues (`q-poll`, `q-triage`, `q-deep`, `q-deliver`) carry bounded at-least-once wake-ups, and a scheduled sweep recovers stalled leases and deferred sends.

### `4` Always-Live Delivery

Alerts are not gated by daily budget caps: items ready during quiet hours or inside the send interval are deferred rather than dropped. Notifications go out to Discord on Cloudflare, with Slack supported through the shared webhook renderer and AWS adapters.

### `5` Public Read-Only Desk

`apps/api` and `apps/web` serve `/`, `/items/:id`, `/alerts/:id`, `/heat`, and optional `/submissions` under strict Content Security Policy (CSP) headers with Zod jitless validation. Each published item gets one article on the desk, and Hacker News refreshes or changelog revisions update its alert documents in place without sending duplicate notifications.

### `6` Portable Boundaries

Shared contracts in `packages/contracts` and generated `oxlint` dependency rules keep Cloudflare, AWS, and provider SDKs out of domain packages. Composition roots wire platform adapters without duplicating domain logic.

## 🛠️ Development

Run `mise run` to list all repository tasks, and run `prek install` once per clone to activate the local static and commit-message hooks. The repository intentionally has no unit-test suite; validate changes with `mise run check` and `mise run build`, or observe the pipeline locally with the Miniflare runner in [tools/local/README.md](./tools/local/README.md) (the local runner calls the live model provider and can incur billing).

<details>
<summary>Operations and architecture guides</summary>

- [ARCHITECTURE.md](./ARCHITECTURE.md): system overview, module map, invariants, and locale seam
- [DEVELOPMENT.md](./DEVELOPMENT.md): toolchain setup, task reference, MCP endpoint, and deployment workflow
- [docs/deployment.md](./docs/deployment.md): Cloudflare `dev` and `prod` environments and Desk PR previews
- [docs/b4-operations-runbook.md](./docs/b4-operations-runbook.md): queue settings, pausing AI or delivery, signals, and incident diagnosis
- [docs/portability.md](./docs/portability.md): Cloudflare-to-AWS mapping and coupling seams
- [docs/public-links.md](./docs/public-links.md): URL validation and withholding rules for stored and published links

</details>

## 📄 License

[MIT](./LICENSE)

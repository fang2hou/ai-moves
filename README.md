<div align="center">

# AI Moves

Watches AI tooling changelogs, GitHub releases, and Hacker News, and publishes what matters as a public reading desk and Discord cards.

</div>

AI Moves polls three source families, scores what changed with deterministic rules, and sends only qualifying items through model analysis. Each published item gets one article on the public desk, and a Discord card when delivery is enabled. Phase 1 runs on Cloudflare Workers, D1, R2, and Queues with OpenRouter models; the domain packages are kept portable for a Phase 2 deployment on AWS. See [ARCHITECTURE.md](./ARCHITECTURE.md) for what is built today and what is still a target.

## 🚀 Quick Start

Requires [mise](https://mise.jdx.dev/) on macOS or Linux. Runtime and tool versions are pinned in `mise.toml`.

```bash
mise install
pnpm install --frozen-lockfile
mise run check
```

## ✨ Features

- Three source families: documentation changelogs split into one item per release, GitHub releases with ETag caching and a newest-only cold start, and Hacker News top-30 momentum scoring.
- Deterministic scoring gates before model analysis and push thresholds before notifications.
- Durable, at-least-once processing: D1 is the source of truth, queues carry wake-ups, and a sweep recovers lost work.
- A public, read-only desk served by one Worker with static assets and security headers.
- Shared, runtime-validated contracts and generated lint boundaries that keep platform code out of domain packages.

## 🛠️ Development

Read [DEVELOPMENT.md](./DEVELOPMENT.md) for the workflow, commands, and deployment, and [CONTRIBUTING.md](./CONTRIBUTING.md) for pull request rules. `mise run` lists all project tasks. There is no unit-test suite; to see the pipeline run end to end, use the local runner in [tools/local](./tools/local/README.md), which calls the live model provider.

## 📄 License

[MIT](./LICENSE)

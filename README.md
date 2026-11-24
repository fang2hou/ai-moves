<div align="center">

# AI Moves

Watches AI tooling changelogs, GitHub releases, and Hacker News, and publishes what matters as a public reading desk and Discord cards.

</div>

AI Moves polls three source families, scores what changed with deterministic rules, and sends only qualifying items through budgeted model analysis. Each published item gets one article on the public desk, and a Discord card when delivery is enabled. Phase 1 runs on Cloudflare Workers, D1, R2, and Queues with OpenRouter models; the domain packages are kept portable for a Phase 2 deployment on AWS. See [ARCHITECTURE.md](./ARCHITECTURE.md) for what is built today and what is still a target.

## 🚀 Quick Start

**With an AI coding agent** — paste this instruction into the agent:

```text
Work in this repository. Read AGENTS.md at the repository root first and follow it.
```

**As a human** — requires mise on macOS or Linux. Runtime and tool versions are pinned in `mise.toml`.

```bash
mise install
pnpm install --frozen-lockfile
mise run check
pnpm --filter @ai-moves/web build
pnpm --filter @ai-moves/api build
```

`mise run` lists all project tasks. There is no unit-test suite; to see the pipeline run end to end, use the local runner in [tools/local](./tools/local/README.md), which calls the live model provider.

## ✨ Features

- Three source families: documentation changelogs split into one item per release, GitHub releases with ETag caching and a newest-only cold start, and Hacker News top-30 momentum scoring.
- Deterministic gates before any model call, with daily budgets per stage and per changelog source.
- Durable, at-least-once processing: D1 is the source of truth, queues carry wake-ups, and a sweep recovers lost work.
- A public, read-only desk served by one Worker with static assets and security headers.
- Shared, runtime-validated contracts and generated lint boundaries that keep platform code out of domain packages.

## 📚 Learn More

| Goal                                 | Read                                                                  |
| ------------------------------------ | --------------------------------------------------------------------- |
| Understand the system and invariants | [ARCHITECTURE.md](./ARCHITECTURE.md)                                  |
| Develop, validate, and deploy        | [DEVELOPMENT.md](./DEVELOPMENT.md)                                    |
| Contribute a change                  | [CONTRIBUTING.md](./CONTRIBUTING.md)                                  |
| Give the repository to an agent      | [AGENTS.md](./AGENTS.md)                                              |
| Operate and diagnose the pipeline    | [docs/b4-operations-runbook.md](./docs/b4-operations-runbook.md)      |
| Understand source and citation links | [docs/public-links.md](./docs/public-links.md)                        |
| Read earlier plans and decisions     | [docs/archive/](./docs/archive/README.md) and [docs/adr/](./docs/adr) |

## 📄 License

License terms have not yet been selected for this repository.

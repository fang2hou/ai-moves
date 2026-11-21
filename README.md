<div align="center">

# AI Moves

A local-first, type-safe monorepo for AI-assisted source monitoring and alert delivery.

</div>

AI Moves turns selected Hacker News and GitHub activity into reviewable, budgeted alerts. The [initial rollout](./docs/adr/0003-initial-feed-only-rollout.md) serves alerts through the authenticated desk without Slack or Discord sends. The pipeline and desk can be exercised locally without connecting to upstream services.

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
```

`mise run` lists all project tasks.

Run `pnpm --filter @ai-moves/pipeline test` for the local pipeline-to-desk scenario.

<details>
<summary>Package commands</summary>

Run a package task directly with `pnpm --filter <package> <script>`. Regenerate the checked-in oxlint configuration after boundary changes with `pnpm lint:config`.

</details>

## ✨ Features

- Shared, runtime-validated contracts for entities, state, messages, ports, configuration, and errors.
- A deterministic kernel for classification, boundaries, configuration, logging, IDs, clocks, and timeouts.
- Reusable in-memory fakes, port contract suites, recorded HTTP fixtures, and a local mock upstream.
- Generated lint boundaries that keep adapters and application components on the intended dependency paths.

## 📚 Learn More

| Goal                                 | Read                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| Understand the system and invariants | [ARCHITECTURE.md](./ARCHITECTURE.md)                 |
| Read the implementation plan         | [docs/architecture-v1.md](./docs/architecture-v1.md) |
| Understand source and citation links | [docs/public-links.md](./docs/public-links.md)       |
| Develop and validate                 | [DEVELOPMENT.md](./DEVELOPMENT.md)                   |
| Contribute a change                  | [CONTRIBUTING.md](./CONTRIBUTING.md)                 |
| Give the repository to an agent      | [AGENTS.md](./AGENTS.md)                             |

## 📄 License

License terms have not yet been selected for this repository.

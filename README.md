<div align="center">

# AI Moves

A public desk that reads the releases of AI coding tools and the Hacker News top 30, and sends a short card to Discord.

</div>

AI Moves runs at [moves.lineyahoo.dev](https://moves.lineyahoo.dev). Every hour a Cloudflare Worker polls the sources and scores them without a model, asks cheap models to triage, analyze and polish, publishes each item as a living document in Simplified Chinese, and sends a card for what clears the bar. The desk is public: nobody signs in to read it.

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

The gate is `mise run check`, which runs a format check, the linter and the type check, plus the build of the desk and of the API Worker that CI runs after it. There is no test suite. [DEVELOPMENT.md](./DEVELOPMENT.md) explains how a change is verified and how to run the pipeline on this machine.

## ✨ Features

- A public desk in Simplified Chinese: the newest items, one page per item, and a page that follows a Hacker News story as its discussion grows.
- Deterministic scoring and a deterministic send decision (`packages/core`), ahead of any model call and after the last one.
- Three model stages through OpenRouter, each debiting a daily budget: triage, deep analysis and a polish pass (`packages/analysis`, `packages/prompts`).
- Release polling for GitHub repositories and for documentation changelogs that have no repository (`packages/ingestion`).
- A Discord card per alert, with a budget, quiet hours and an expiry (`packages/delivery`).

The sources a deployment watches are part of its published configuration. `tools/local/seed-sql.ts` prints the initial set: the releases of `can1357/oh-my-pi`, `stablyai/orca` and `earendil-works/pi`, and the documentation changelogs of Claude Code, of ChatGPT & Codex, and of Antigravity (the app and the CLI).

## 📚 Learn More

| Goal                                     | Read                                                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Understand the system and its invariants | [ARCHITECTURE.md](./ARCHITECTURE.md)                                                                                                                      |
| Why the product looks the way it does    | [The ADRs](./docs/adr/0004-public-desk-access-for-administration.md) in `docs/adr/`; the plan they replaced is in [the archive](./docs/archive/README.md) |
| Understand source and citation links     | [docs/public-links.md](./docs/public-links.md)                                                                                                            |
| Develop, verify and deploy               | [DEVELOPMENT.md](./DEVELOPMENT.md)                                                                                                                        |
| Run the pipeline on this machine         | [tools/local/README.md](./tools/local/README.md)                                                                                                          |
| Contribute a change                      | [CONTRIBUTING.md](./CONTRIBUTING.md)                                                                                                                      |
| Give the repository to an agent          | [AGENTS.md](./AGENTS.md)                                                                                                                                  |

## 📄 License

License terms have not yet been selected for this repository.

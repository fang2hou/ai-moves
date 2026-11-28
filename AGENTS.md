# AI News Tracker

Guidance for AI agents working in this TypeScript monorepo. Read this before making changes.

AI News Tracker watches web changelogs, GitHub releases, Hacker News, and MCP reader submissions for engineers tracking AI tooling, then publishes a public reading desk alongside Discord and Slack alerts.

## Commands

```bash
mise install                  # set up pinned runtimes and CLIs
pnpm install --frozen-lockfile
prek install                  # activate pre-commit and commit-msg hooks once per clone
mise run format-check         # formatting check only
mise run lint                 # lint and boundary check only
mise run typecheck            # type checking only
mise run secret-scan          # gitleaks secret scan
mise run check                # full static CI gate; run before every commit
mise run build                # web assets, Lambda bundles, and API Worker bundle
pnpm lint:config              # regenerate .oxlintrc.json after boundary changes
```

Use `pnpm`, never `npm` or `yarn`. `mise run check` (format check, lint, type check, secret scan) and `mise run build` are the CI gate; run both before every commit.

## Engineering Standards

Follow the shared [AI Coding Guidelines PORTAL](https://github.com/fang2hou/ai-coding-guidelines/blob/main/PORTAL.md) and this repository's [ARCHITECTURE.md](./ARCHITECTURE.md). Read the portal's reading recipe for your task type before starting; repository documentation takes precedence for project-specific boundaries.

Project-specific overrides: intentionally no unit-test suite; verified via `mise run check`, `mise run build`, and offline tools in `tools/local/`.

## Layout

- `apps/`: composition roots for `pipeline` and `api` (Cloudflare Workers and AWS Lambda) and `web` (the static desk).
- `packages/`: portable domain and adapters (`contracts`, `core`, `kernel`, `ingestion`, `analysis`, `delivery`, `prompts`, `locales`, `sources`, `llm`, `storage`) and platform adapters (`storage-d1`, `runtime-cloudflare`, `storage-dynamodb`, `runtime-aws`).
- `tooling/`: shared TypeScript configuration and the generated `oxlint` dependency boundaries.
- `tools/local/`: local runner, model probes, and offline SQL, JSON, and DynamoDB utilities; see [tools/local/README.md](./tools/local/README.md).
- `docs/`: operations runbook ([docs/b4-operations-runbook.md](./docs/b4-operations-runbook.md)), deployment guide ([docs/deployment.md](./docs/deployment.md)), portability guide ([docs/portability.md](./docs/portability.md)), public-link policy ([docs/public-links.md](./docs/public-links.md)), rename migration runbook ([docs/rename-migration.md](./docs/rename-migration.md)), ADRs (`docs/adr/`), and pre-redesign archive (`docs/archive/`).

## Boundaries

Always:

- Run `mise run check` and `mise run build` before every commit.
- Keep each change minimal and scoped to the request.
- Keep domain logic independent of Cloudflare, AWS, and provider SDKs.
- Import workspace packages through their declared public subpaths; do not add barrel files.
- Regenerate `.oxlintrc.json` with `pnpm lint:config` after changing `tooling/src/boundaries.ts` or `tooling/src/oxlint-config.ts`.
- Update documentation in the same change when setup, commands, behavior, or architecture changes.

Never:

- Commit secrets or production credentials.
- Push directly to `main`.
- Hand-edit `.oxlintrc.json`; regenerate it with `pnpm lint:config`.
- Add a dependency without documenting why the existing toolchain cannot meet the requirement.
- Run the model-calling scripts in `tools/local/` (`run.ts`, `probe-model.ts`, `probe-deep.ts`) casually: each run calls the live provider and can be billed. `schema-sql.ts`, `seed-sql.ts`, `seed-dynamodb.ts`, `dynamodb-table.ts`, `card-json.ts`, and `discord-mock.mjs` call no model.

Ask first:

- Changes to invariants in `ARCHITECTURE.md`.
- Deploying to `prod`, creating Cloudflare or AWS resources, running production migrations, or changing credentials.
- Destructive git history operations or shared-branch force pushes.

## Confirmed Language Policy

| Item                                                                | Value                                                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Conversation                                                        | Follow the user's language                                                                         |
| Code, comments, commits, docs, logs, error codes, and core defaults | English                                                                                            |
| Product UI text and published output                                | Pluggable locale packs: `en` default; `zh-CN` for the personal Cloudflare deployment, `ja` for AWS |
| Tone                                                                | Technical and concise                                                                              |

Never hardcode non-English strings in core packages or error paths. Do not infer the UI language from the conversation language. Use `packages/locales` for localized reader copy, Discord and Slack labels, and writing rules. See [ARCHITECTURE.md](./ARCHITECTURE.md#language-policy-and-locale-seam).

## Project Conventions

- Use ESM and strict TypeScript.
- Write self-explaining code through clear naming and small functions; keep comments strictly for non-obvious invariants or external constraints, and avoid defensive branches for impossible states.
- Model failures with `AppError` and the error codes in `@ai-news-tracker/contracts/errors`.

Depth: [DEVELOPMENT.md](./DEVELOPMENT.md) for workflow, [CONTRIBUTING.md](./CONTRIBUTING.md) for review and pull request rules, [ARCHITECTURE.md](./ARCHITECTURE.md) for invariants, and [tools/local/README.md](./tools/local/README.md) for local utilities.

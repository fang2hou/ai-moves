# AI News Tracker

Guidance for AI agents working in this TypeScript monorepo. It watches web changelogs, GitHub releases, Hacker News, and MCP reader submissions, analyzes what qualifies, and publishes a public desk alongside Discord and Slack alerts.

## Commands

```bash
mise install
pnpm install --frozen-lockfile
prek install
mise run check
mise run secret-scan
mise run build
pnpm lint:config
```

Use pnpm, not npm or yarn. `mise run check` (format check, lint, type check, secret scan) and `mise run build` are the CI gate; run them before every commit. The repository intentionally has no unit-test suite and no test task.

## Engineering Standards

Follow the shared [AI Coding Guidelines](https://github.com/fang2hou/ai-coding-guidelines) and this repository's [ARCHITECTURE.md](./ARCHITECTURE.md). The repository documentation is the source of truth for project-specific boundaries.

## Layout

- `apps/` — composition roots: `pipeline` and `api` (Cloudflare Workers and AWS Lambda) and `web` (the static desk).
- `packages/` — `contracts`, `core`, `kernel`, `ingestion`, `analysis`, `delivery`, `prompts`, `locales`, `sources`, `llm`, and `storage` (portable domain and adapters); `storage-d1`, `runtime-cloudflare`, `storage-dynamodb`, and `runtime-aws` (platform adapters).
- `tooling/` — shared TypeScript configuration and the generated oxlint dependency boundaries.
- `tools/local/` — local runner, model probes, and offline SQL/JSON/DynamoDB utilities.
- `docs/` — operations runbook, deployment and portability guides, rename migration runbook, public-link policy, ADRs, and the archive of pre-redesign plans.

## Confirmed Language Policy

| Item                                                                | Value                                                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Conversation                                                        | Follow the user's language                                                                         |
| Code, comments, commits, docs, logs, error codes, and core defaults | English                                                                                            |
| Product UI text and published output                                | Pluggable locale packs: `en` default; `zh-CN` for the personal Cloudflare deployment, `ja` for AWS |
| Tone                                                                | Technical and concise                                                                              |

Never hardcode non-English strings in core packages or error paths. Do not infer the UI language from the conversation language. Use `packages/locales` for localized reader copy, Discord and Slack labels, and writing rules. See [ARCHITECTURE.md](./ARCHITECTURE.md#language-policy-and-locale-seam).

## Boundaries

Always:

- Keep domain logic independent of Cloudflare, AWS, and provider SDKs.
- Import workspace packages through their declared public subpaths; do not add barrel files.
- Regenerate `.oxlintrc.json` with `pnpm lint:config` after changing `tooling/src/boundaries.ts` or `tooling/src/oxlint-config.ts`.
- Update documentation in the same change when setup, commands, behavior, or architecture changes.

Never:

- Commit secrets or production credentials.
- Push directly to `main`.
- Hand-edit `.oxlintrc.json`; regenerate it.
- Add a dependency without documenting why the existing toolchain cannot meet the requirement.
- Run the model-calling scripts in `tools/local/` (`run.ts`, `probe-model.ts`, `probe-deep.ts`) casually: each run calls the live provider and can be billed. `schema-sql.ts`, `seed-sql.ts`, `seed-dynamodb.ts`, `dynamodb-table.ts`, `card-json.ts`, and `discord-mock.mjs` call no model.

Ask first:

- Changes to invariants in `ARCHITECTURE.md`.
- Deploying to `prod`, creating Cloudflare or AWS resources, running production migrations, or changing credentials.
- Destructive git history operations or shared-branch force pushes.

## Project Conventions

- Use ESM and strict TypeScript.
- Model failures with `AppError` and the error codes in `@ai-news-tracker/contracts/errors`.

Depth: [DEVELOPMENT.md](./DEVELOPMENT.md) for workflow, [CONTRIBUTING.md](./CONTRIBUTING.md) for review requirements, and [ARCHITECTURE.md](./ARCHITECTURE.md) for invariants.

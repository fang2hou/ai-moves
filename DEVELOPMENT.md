# Development

This guide covers setup, workflow, validation, and deployment for humans and AI agents. Product context is in [README.md](./README.md); boundaries and invariants are in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Setup

All runtime and project CLI versions are managed by mise.

```bash
mise install
pnpm install --frozen-lockfile
```

| Tool       | Purpose                                        | Managed via           |
| ---------- | ---------------------------------------------- | --------------------- |
| Node.js 26 | Runtime                                        | `mise.toml`           |
| pnpm 12    | Workspace and package manager                  | `mise.toml`           |
| prek       | Pre-commit checks                              | `mise.toml`           |
| TypeScript | Type checking                                  | `pnpm-workspace.yaml` |
| oxlint     | Lint, type-aware rules, and package boundaries | `pnpm-workspace.yaml` |
| oxfmt      | Formatting                                     | `pnpm-workspace.yaml` |
| Vite       | Desk assets and the API Worker bundle          | `pnpm-workspace.yaml` |
| Wrangler   | Worker bundling, D1 migrations, and deployment | `pnpm-workspace.yaml` |

Do not replace a pinned tool without an explicit project decision.

## Commands

```bash
mise run format          # write formatting
mise run format-check
mise run lint
mise run typecheck
mise run check           # format-check, lint, and typecheck; the CI static gate
pnpm --filter @ai-moves/web build
pnpm --filter @ai-moves/api build
pnpm lint:config         # regenerate .oxlintrc.json after a boundary change
```

The repository intentionally has no unit-test suite. CI (`.github/workflows/ci.yml`, job `Verify`) runs `mise run check` and the two builds on every pull request.

## Workflow

1. Create a focused branch from `main`.
2. Read `ARCHITECTURE.md` and the relevant package sources.
3. Make the smallest complete change for the requirement, and update the affected documentation in the same change.
4. Run `pnpm lint:config` when `tooling/src/boundaries.ts` or `tooling/src/oxlint-config.ts` changes.
5. Run `mise run check` and both builds; `prek run --all-files` runs the same static hooks.
6. Commit with a Conventional Commit and open a pull request.

## Coding Standards

- Use strict TypeScript and ESM.
- Use standard English for identifiers, comments, configuration names, logs, and commits; reader-facing text belongs in locale packs (see [ARCHITECTURE.md](./ARCHITECTURE.md#language-policy-and-locale-seam)).
- Import from the defining module or a declared package subpath; no barrel files.
- Use `AppError` rather than unclassified native errors in bounded application code.
- Keep comments sparse; explain only non-obvious invariants, hazards, or rationale.
- Avoid dependencies, abstractions, and modules without a concrete current use case.

## Verifying Behavior

There is no test suite, so a behavior change is observed by running it. Options, cheapest first:

- Offline utilities in `tools/local/` that call no model: `schema-sql.ts` (render pending migrations), `seed-sql.ts` (print the seed SQL for a fresh database; applying it is manual), `discord-mock.mjs` (a local Discord stand-in), and `card-json.ts` (render a Discord card from a deployed desk's public read API).
- The `dev` deployment, started by hand with `POST /trigger` (see [Deployment](#deployment)).
- The local pipeline below. It calls the live model provider, so run it only when asked.

### Local pipeline

`tools/local/run.ts` runs the real pipeline Worker and desk in Miniflare with a local D1 and R2, polls the live Hacker News, GitHub, and changelog sources on a timer, and posts cards to the local Discord stand-in. See [tools/local/README.md](./tools/local/README.md) for setup and variables. Nothing is deployed and no Cloudflare resource is created.

### Pipeline Worker bindings

| Binding                                                     | Contract                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `DB`, `BLOBS`                                               | D1 with the storage schema, and the content-addressed R2 bucket                                                                           |
| `POLL_QUEUE`, `TRIAGE_QUEUE`, `DEEP_QUEUE`, `DELIVER_QUEUE` | Producers for `q-poll`, `q-triage`, `q-deep`, and `q-deliver`                                                                             |
| `ENVIRONMENT`, optional `LOG_LEVEL`, `DESK_ORIGIN`          | Runtime settings, and the credential-free HTTPS origin written into document links                                                        |
| `GITHUB_TOKEN`, `OPENROUTER_API_KEY`                        | Provider secrets; every persisted model route must name `openrouter`                                                                      |
| Optional `DISCORD_WEBHOOK_URL`                              | Secret named by the Discord destination's `secret_ref`                                                                                    |
| Optional `TRIGGER_TOKEN`                                    | At least 16 characters; enables `POST /trigger` with header `x-trigger-token`                                                             |
| `PROVIDER_HTTP`, `PINNED_WEB`                               | Outbound HTTP. A deployed Worker builds both from the platform `fetch` (`apps/pipeline/src/egress.ts`); the local runner supplies its own |

The Worker reads the latest configuration version from D1 on every event and fails closed without one. Queue consumers retry or acknowledge each message individually; a malformed batch envelope or unusable configuration rejects the whole invocation.

## Deployment

`.github/workflows/deploy.yml` deploys both Workers:

| Trigger                    | Environment | Notes                                                                      |
| -------------------------- | ----------- | -------------------------------------------------------------------------- |
| Push to `main`             | `dev`       | No cron. Start a run with `POST /trigger` and the `x-trigger-token` header |
| Published GitHub Release   | `prod`      | Every 30 minutes (`*/30 * * * *`); desk at `moves.lineyahoo.dev`           |
| Manual `workflow_dispatch` | Chosen      | `dev` or `prod`                                                            |

Each run checks and builds, dry-runs both bundles, reads the target database's `storage_migrations` ledger, applies only unrecorded migrations rendered by `tools/local/schema-sql.ts`, and then deploys the pipeline and the desk. Worker secrets are set outside the repository. Deploying to `prod`, creating Cloudflare or AWS resources, running production migrations, and changing credentials require the owner's approval.

### Desk pull request previews

[Desk PR Preview](./.github/workflows/preview.yml) runs on same-repository pull requests with the GitHub `preview` environment. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_PREVIEW_API_TOKEN` there. Use a dedicated token with the minimum Workers permissions needed to upload Desk preview versions and assets. The deploy token stays in the deploy environments. If either preview secret is missing, the job records the missing secret in its summary and skips the upload. It builds the web assets using `DESK_LOCALE` (default `zh-CN`) and publishes a public `pr-<number>` Version URL in the job summary. Each upload targets `ai-moves-desk-dev` and uses only `ai-moves-dev` D1 (`5bcc51a7-b879-4a33-ab9a-7a473041125b`), with no pipeline, migrations, production resources, or changes to active traffic.

Wrangler 4.166.0 supports a dry run for `versions upload`. Its separate `preview` command has no dry-run flag. Run these checks from the repository root:

```sh
VITE_LOCALE=zh-CN pnpm --filter @ai-moves/web build
node_modules/.bin/wrangler deploy --dry-run --config apps/api/wrangler.jsonc --env dev
node_modules/.bin/wrangler deploy --dry-run --config apps/api/wrangler.jsonc --env prod
node_modules/.bin/wrangler versions upload --dry-run --config apps/api/wrangler.jsonc --env dev --preview-alias pr-9999
```

The preview and dev bundles should report `env.DB (ai-moves-dev)`; the prod bundle should report `env.DB (ai-moves)`.

## Deferred Git Governance

Credential scanning, `.gitattributes`, commit-message checks, and pull-request title validation remain follow-up work. They must land through a dedicated Git-only pull request; the current static checks do not imply them.

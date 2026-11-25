# Development

This guide covers setup, workflow, validation, and deployment for humans and AI agents. Product context is in [README.md](./README.md); boundaries and invariants are in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Setup

All runtime and project CLI versions are managed by mise.

```bash
mise install
pnpm install --frozen-lockfile
prek install
```

`prek install` activates the Git hooks (`pre-commit` and `commit-msg`) in the current clone. Run it once per clone; a clone without it has no local commit checks.

| Tool       | Purpose                                            | Managed via           |
| ---------- | -------------------------------------------------- | --------------------- |
| Node.js 26 | Runtime                                            | `mise.toml`           |
| pnpm 12    | Workspace and package manager                      | `mise.toml`           |
| prek       | Pre-commit and commit-msg hooks                    | `mise.toml`           |
| Cocogitto  | Conventional Commit validation (local hook and CI) | `mise.toml`           |
| gitleaks   | Secret scanning                                    | `mise.toml`           |
| TypeScript | Type checking                                      | `pnpm-workspace.yaml` |
| oxlint     | Lint, type check, and package boundaries           | `pnpm-workspace.yaml` |
| oxfmt      | Formatting                                         | `pnpm-workspace.yaml` |
| Vite       | Desk assets and the API Worker bundle              | `pnpm-workspace.yaml` |
| Wrangler   | Worker bundling, D1 migrations, and deployment     | `pnpm-workspace.yaml` |

Do not replace a pinned tool without an explicit project decision.

## Commands

```bash
mise run format          # write formatting
mise run format-check
mise run lint
mise run typecheck
mise run secret-scan     # scan the working tree for secrets
mise run check           # format-check, lint, typecheck, and secret-scan; the CI static gate
mise run build-web       # the desk assets, in the locale VITE_LOCALE selects (en when unset)
mise run build           # build-web, then the API Worker bundle; the CI build gate
pnpm lint:config         # regenerate .oxlintrc.json after a boundary change
```

The repository intentionally has no unit-test suite. CI (`.github/workflows/ci.yml`, job `Verify`) runs `mise run check` and `mise run build` on every pull request.

## Workflow

1. Create a focused branch from `main`.
2. Read `ARCHITECTURE.md` and the relevant package sources.
3. Make the smallest complete change for the requirement, and update the affected documentation in the same change.
4. Run `pnpm lint:config` when `tooling/src/boundaries.ts` or `tooling/src/oxlint-config.ts` changes.
5. Run `mise run check` and `mise run build`; `prek run --all-files` runs the same static hooks.
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

| Binding                                                     | Contract                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `DB`, `BLOBS`                                               | D1 with the storage schema from `packages/storage-d1`, and the content-addressed R2 bucket                                                 |
| `POLL_QUEUE`, `TRIAGE_QUEUE`, `DEEP_QUEUE`, `DELIVER_QUEUE` | Producers for `q-poll`, `q-triage`, `q-deep`, and `q-deliver`                                                                              |
| `ENVIRONMENT`, optional `LOG_LEVEL`, `DESK_ORIGIN`          | Runtime settings, and the credential-free HTTPS origin written into document links                                                         |
| `GITHUB_TOKEN`, `OPENROUTER_API_KEY`                        | Provider secrets; every persisted model route must name `openrouter` (checked by `deploymentConfigIssue` in `apps/pipeline/src/worker.ts`) |
| Optional `DISCORD_WEBHOOK_URL`                              | Secret named by the Discord destination's `secret_ref`                                                                                     |
| Optional `TRIGGER_TOKEN`                                    | At least 16 characters; enables `POST /trigger` with header `x-trigger-token`                                                              |
| `PROVIDER_HTTP`, `PINNED_WEB`                               | Outbound HTTP. A deployed Worker builds both from the platform `fetch` (`apps/pipeline/src/egress.ts`); the local runner supplies its own  |

The Worker reads the latest configuration version from D1 on every event and fails closed without one. Queue consumers retry or acknowledge each message individually; a malformed batch envelope or unusable configuration rejects the whole invocation.

## Deployment

`.github/workflows/deploy.yml` deploys both Workers:

| Trigger                    | Environment | Notes                                                                      |
| -------------------------- | ----------- | -------------------------------------------------------------------------- |
| Push to `main`             | `dev`       | No cron. Start a run with `POST /trigger` and the `x-trigger-token` header |
| Published GitHub Release   | `prod`      | Every 5 minutes (`*/5 * * * *`); desk at `moves.lineyahoo.dev`             |
| Manual `workflow_dispatch` | Chosen      | `dev` or `prod`                                                            |

Each run checks and builds, dry-runs both bundles, reads the target database's `storage_migrations` ledger, applies only unrecorded migrations rendered by `tools/local/schema-sql.ts`, and then deploys the pipeline and the desk. The Worker applies the storage migrations itself against a local database. A remote one is brought up to date by its ledger of recorded migrations: the ledger is created where it is missing, so that reading it cannot fail on a database without one, and only the migrations it does not record are applied. Each migration the script renders ends with its own ledger record, so one such record in the rendered file means there is something to apply. Worker secrets are set outside the repository. Deploying to `prod`, creating Cloudflare or AWS resources, running production migrations, and changing credentials require the owner's approval.

Wrangler is a dev dependency of the repository root because nothing else here can deploy a Worker, and the Wrangler action an earlier version of this workflow used installs its own copy with `pnpm add`, which pnpm refuses in a workspace root. The workflow therefore runs the installed binary (`node_modules/.bin/wrangler`) rather than `pnpm exec`: `pnpm exec` may run an install first and print it on stdout, which a later step would read as the JSON it expects. A dry run bundles a Worker locally and contacts nothing, so a bundle that does not build fails before anything touches the database. `dev` has no cron because a run is started by hand, so it does not call models on a schedule. The `prod` cron ticks every five minutes to sample Hacker News (300 seconds); GitHub releases (600 seconds) and web changelogs (1800 seconds) are polled less often, as each source's `poll_interval_sec` governs.

### Desk pull request previews

[Desk PR Preview](./.github/workflows/preview.yml) runs on same-repository pull requests with the GitHub `preview` environment. The job therefore runs pull-request code with the preview token in scope. That is accepted for this personal repository: the same-repository condition limits it to authors who already have write access, and a required reviewer on the environment would block the preview of every pull request opened by the owner. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_PREVIEW_API_TOKEN` there. Use a dedicated token with the minimum Workers permissions needed to upload Desk preview versions and assets. The deploy token stays in the deploy environments. If either preview secret is missing, the job records the missing secret in its summary and skips the upload. It builds the web assets using `DESK_LOCALE` (default `zh-CN`) and publishes a public `pr-<number>` Version URL in the job summary. Each upload targets `ai-moves-desk-dev` and uses only `ai-moves-dev` D1 (`5bcc51a7-b879-4a33-ab9a-7a473041125b`), with no pipeline, migrations, production resources, or changes to active traffic.

Wrangler 4.166.0 supports a dry run for `versions upload`. Its separate `preview` command has no dry-run flag. Run these checks from the repository root:

```sh
VITE_LOCALE=zh-CN pnpm --filter @ai-moves/web build
node_modules/.bin/wrangler deploy --dry-run --config apps/api/wrangler.jsonc --env dev
node_modules/.bin/wrangler deploy --dry-run --config apps/api/wrangler.jsonc --env prod
node_modules/.bin/wrangler versions upload --dry-run --config apps/api/wrangler.jsonc --env dev --preview-alias pr-9999
```

The preview and dev bundles should report `env.DB (ai-moves-dev)`; the prod bundle should report `env.DB (ai-moves)`.

## Git Governance

Conventional Commits and secret hygiene are enforced by Cocogitto and gitleaks, both installed from `mise.toml`.

| Where                        | Check                                                                                    | Fails when                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `pre-commit` hook            | `format-check`, `lint`, `typecheck`, and `secret-scan`, each through its `mise run` task | Any of the four tasks fails                           |
| `commit-msg` hook            | `cog verify` on the message being committed                                              | The message is not a Conventional Commit              |
| CI `Validate PR title`       | `cog verify` on the pull-request title                                                   | The title is not a Conventional Commit                |
| CI `Validate commit history` | `cog check` on the commits the pull request adds (`origin/<base>..HEAD`)                 | Any added commit message is not a Conventional Commit |

- The hooks exist only after `prek install`. `prek run --all-files` runs the pre-commit hooks without committing; `prek run --stage commit-msg --commit-msg-filename <file>` runs the commit-msg hook on a message file.
- A merge commit message (`Merge branch ...`) is accepted by the hook and by both CI checks, so merging `main` into a branch is not blocked.
- The CI jobs live in [Validate pull request](./.github/workflows/pr-title.yml) and run when a pull request is opened, synchronized, reopened, or retitled. The title is validated because a squash merge takes the final commit message from the pull-request title.
- The commit history is checked over `origin/<base branch>..HEAD` rather than the whole history: `main` contains commits older than this rule whose messages are not Conventional Commits. The range starts from the base branch's current tip, so it holds after the base branch moves.
- `mise run secret-scan` runs `gitleaks dir . --redact` on the working tree, following `.gitignore` (`node_modules` is not scanned). It is part of `mise run check`, so CI runs it too. A finding is a real secret until proven otherwise: remove the secret, never the rule. A confirmed false positive gets a line in `.gitleaksignore` naming the file and the rule.

## Repository Attributes

[`.gitattributes`](./.gitattributes) keeps GitHub's language statistics on code: no file is counted unless it is re-included. `apps/`, `packages/`, `tooling/`, and `tools/` are counted as source; JSON, JSONC, TOML, YAML, and SVG files inside them are not. Markdown counts as documentation, and `pnpm-lock.yaml` is marked generated.

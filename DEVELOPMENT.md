# Development

This guide covers repository setup, workflows, and validation for humans and AI agents. Product-facing setup is in [README.md](./README.md).

## Setup

All runtime and project CLI versions are managed by mise.

```bash
mise install
pnpm install --frozen-lockfile
```

| Tool       | Purpose                                  | Managed via           |
| ---------- | ---------------------------------------- | --------------------- |
| Node.js 26 | Runtime. It runs `.ts` files directly.   | `mise.toml`           |
| pnpm 12    | Workspace and package manager            | `mise.toml`           |
| prek       | Pre-commit checks                        | `mise.toml`           |
| TypeScript | Type checking                            | `pnpm-workspace.yaml` |
| oxlint     | Lint and type-aware rules                | `pnpm-workspace.yaml` |
| oxfmt      | Formatting, Markdown included            | `pnpm-workspace.yaml` |
| Vite       | The desk pages and the API Worker bundle | `pnpm-workspace.yaml` |
| wrangler   | Bundling and deploying the Workers       | `pnpm-workspace.yaml` |

Do not replace a pinned tool without an explicit project decision.

## Commands

```bash
mise run format                        # oxfmt
mise run format-check                  # oxfmt --check
mise run lint                          # oxlint
mise run typecheck                     # tsc -b
mise run check                         # the three checks above
pnpm lint:config                       # regenerate .oxlintrc.json, after a change to tooling/src
pnpm --filter @ai-moves/web build      # the desk pages, into apps/web/dist
pnpm --filter @ai-moves/api build      # the API Worker bundle, into apps/api/dist/worker
```

`mise run check` is the static validation that CI and the deploy workflow both run. `prek.toml` names the same three checks as pre-commit hooks, and `prek run --all-files` runs them on every file.

## Workflow

1. Create a focused branch from `main`.
2. Read `ARCHITECTURE.md` and the relevant package sources.
3. Make the smallest complete change for the requirement.
4. Run `pnpm lint:config` when dependency boundaries change.
5. Verify the behavior by running it (see [Validation](#validation)).
6. Run `mise run check`, and the build of whatever you changed.
7. Review the staged diff, commit with a Conventional Commit, and open a pull request.

## Coding Standards

- Use strict TypeScript and ESM.
- Use standard English for identifiers, comments, configuration names, and commits.
- Prefer direct imports from the defining module or an explicit package subpath.
- Use `AppError` rather than unclassified native errors in bounded application code.
- Keep comments sparse; explain only non-obvious invariants, hazards, or rationale.
- Avoid dependencies, abstractions, and modules without a concrete current use case.

## Validation

There is no test suite ([ADR-0008](./docs/adr/0008-static-checks-instead-of-a-test-suite.md)). The gate is static, and a behavior change is verified by running it.

```bash
mise run check
pnpm --filter @ai-moves/web build
pnpm --filter @ai-moves/api build
prek run --all-files
```

1. `mise run check` must pass. CI runs the same task and then the two builds (`.github/workflows/ci.yml`).
2. Run the behavior you changed. Write a throwaway script, run it with `node some-file.ts`, and use fakes or fixtures for everything external: a model provider, Discord, GitHub, Hacker News, or a remote database is never contacted. Ports take the clock, the IDs, and the network client, so a real function can be driven with plain objects. Delete the script before you commit, and quote its output in the pull request.
3. Build what you changed. `apps/pipeline` has no build script; CI covers it with the static checks only.

To prove that the pipeline still bundles without deploying, bundle it locally. A dry run contacts nothing and needs no login:

```bash
node_modules/.bin/wrangler deploy --dry-run --config apps/pipeline/wrangler.jsonc --env dev
```

## Local demo

`tools/local/run.ts` runs the real pipeline Worker on a timer against the live Hacker News API and the live model provider, serves the desk, and posts cards to a local Discord stand-in. Nothing is deployed and no real webhook is called. The model calls cost money, so run it only when the owner asks. [tools/local/README.md](./tools/local/README.md) has the setup, the environment variables, and what to expect.

```bash
pnpm --filter @ai-moves/web build            # the desk pages the demo serves
pnpm --filter @ai-moves/local-demo discord   # the Discord stand-in, in one terminal
pnpm --filter @ai-moves/local-demo start     # the pipeline and the desk, in another
```

Without `OPENROUTER_API_KEY`, polling and scoring run and analysis does not. The demo publishes the configuration with `delivery.feed_only` left at its default, so the Worker plans no delivery; the runner itself posts the first document of each story to the stand-in (`notifyNewDocuments` in `tools/local/run.ts`).

## Running a tick by hand

Production runs on an hourly cron and `dev` has none (`apps/pipeline/wrangler.jsonc`). One tick can be run on a deployment with a secret only the owner holds:

```bash
curl -X POST -H "x-trigger-token: $TRIGGER_TOKEN" https://<pipeline-worker>/trigger
```

It runs exactly what the schedule runs and answers `{"ran":"scheduled","at":<ms>}`. Any other method, path, or token answers `404 Not found`, and with no `TRIGGER_TOKEN` set on the Worker there is no way in (`apps/pipeline/src/worker.ts`).

## Deployment

`.github/workflows/deploy.yml` deploys both Workers and applies the storage migrations.

| Event                                                 | Environment    | Database       |
| ----------------------------------------------------- | -------------- | -------------- |
| A push to `main`                                      | `dev`          | `ai-moves-dev` |
| A published release                                   | `prod`         | `ai-moves`     |
| A manual run of the workflow, with an environment set | the chosen one | as above       |

A run does the following, in order:

1. Runs `mise run check` and builds the desk pages.
2. Bundles both Workers with `wrangler deploy --dry-run`, so a Worker that does not build fails the run before anything is touched.
3. Reads the migrations the target database has recorded, renders only the pending ones with `node tools/local/schema-sql.ts --applied <file>`, and applies them.
4. Deploys the pipeline, then the desk.

So every push to `main` is a deployment to `dev`. Creating or changing a Cloudflare resource, a secret, or production data by hand still needs the owner's approval.

The rows a fresh database needs, the configuration version, the sources, and the Discord destination, are printed by `node tools/local/seed-sql.ts`. The seed holds no secret: the destination names the `DISCORD_WEBHOOK_URL` binding, which is set on the pipeline Worker as a secret.

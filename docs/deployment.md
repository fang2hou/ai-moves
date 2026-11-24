# Deployment

Where the two Cloudflare environments come from, what a deploy applies, and how desk previews are produced. The step-by-step procedure is in [DEVELOPMENT.md](../DEVELOPMENT.md#deployment); operating the result is in the [operations runbook](./b4-operations-runbook.md).

## Current (`main`)

| Environment | Deployed by                                                  | Pipeline schedule                          | Desk                                     |
| ----------- | ------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------- |
| `dev`       | Every push to `main` (or a manual `workflow_dispatch`)       | No cron; a run starts with `POST /trigger` | `ai-moves-desk-dev.fang2hou.workers.dev` |
| `prod`      | A published GitHub Release (or a manual `workflow_dispatch`) | Every 5 minutes, `*/5 * * * *`             | `moves.lineyahoo.dev` (custom domain)    |

`.github/workflows/deploy.yml` runs `mise run check`, builds the desk, dry-runs both Worker bundles, applies pending D1 schema migrations through the recorded ledger, then deploys the pipeline and the desk. Initial rows (the published configuration, sources, and destinations) are not part of `.github/workflows/deploy.yml`, which applies schema migrations only: `tools/local/seed-sql.ts` prints the seed SQL, and applying it to a database is a separate, manual initialization step. `.github/workflows/ci.yml` (job `Verify`) runs the check and both builds on every pull request. `dev` and `prod` use separate D1 databases, R2 buckets, and queues (`dev` names carry a `-dev` suffix); production consumers use `max_batch_size: 1` for `q-deep` and 10 for the other queues.

## Desk pull request previews

[Desk PR Preview](../.github/workflows/preview.yml) uploads an aliased Version URL on `ai-moves-desk-dev` for each same-repository pull request. The job uses the GitHub `preview` environment and a dedicated `CLOUDFLARE_PREVIEW_API_TOKEN` scoped to the Workers version and asset uploads required for previews. The workflow selects `--env dev` in `apps/api/wrangler.jsonc`, where `preview_urls: true` enables Version URLs and `DB` points to `ai-moves-dev` (`5bcc51a7-b879-4a33-ab9a-7a473041125b`). Previews share the dev database. The upload excludes the production Worker, domain, and database, and it runs without pipeline deployment or D1 migrations. See [Development](../DEVELOPMENT.md#desk-pull-request-previews) for the preview workflow and local verification commands.

# Rename migration runbook (GitHub and Cloudflare)

Stage 1 renamed the repository packages (`ai-news-tracker`, `@ai-news-tracker/*`), English brand strings, and workflow guards while leaving live Cloudflare resources on their legacy `ai-moves-*` names. Follow this runbook to rename the GitHub repository and cut over Cloudflare `dev` and `prod` resources without data loss, keeping a tested rollback path throughout.

This infrastructure rename is separate from the Cloudflare-to-AWS portability track described in [docs/portability.md](./portability.md).

## Resource mapping

All Cloudflare resources containing `ai-moves` move to `ai-news-tracker` equivalents, whereas the queue names carry no project prefix and stay unchanged.

| Resource                | Legacy Phase 1 name                                     | Target name                                             | Notes                                                       |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| GitHub repository       | `fang2hou/ai-moves`                                     | `fang2hou/ai-news-tracker`                              | GitHub redirects old remotes; update local origins anyway   |
| `dev` Pipeline Worker   | `ai-moves-pipeline-dev`                                 | `ai-news-tracker-pipeline-dev`                          | `apps/pipeline/wrangler.jsonc` (`env.dev.name`)             |
| `dev` Desk Worker       | `ai-moves-desk-dev`                                     | `ai-news-tracker-desk-dev`                              | `apps/api/wrangler.jsonc` (`env.dev.name`, `preview_urls`)  |
| `dev` D1 database       | `ai-moves-dev` (`5bcc51a7-b879-4a33-ab9a-7a473041125b`) | `ai-news-tracker-dev` (new UUID)                        | Export and import SQL before deploying renamed Workers      |
| `dev` R2 bucket         | `ai-moves-blobs-dev`                                    | `ai-news-tracker-blobs-dev`                             | Copy blobs via S3-compatible sync or R2 Super Slurper       |
| `dev` Desk origin       | `https://ai-moves-desk-dev.fang2hou.workers.dev`        | `https://ai-news-tracker-desk-dev.fang2hou.workers.dev` | `DESK_ORIGIN` var and `tools/local/card-json.ts` default    |
| `prod` Pipeline Worker  | `ai-moves-pipeline`                                     | `ai-news-tracker-pipeline`                              | Top-level `name` and `env.prod.name`                        |
| `prod` Desk Worker      | `ai-moves-desk`                                         | `ai-news-tracker-desk`                                  | Top-level `name` and `env.prod.name`                        |
| `prod` D1 database      | `ai-moves` (`f10018d6-1cc2-4746-bad8-c8a3ec17d2fa`)     | `ai-news-tracker` (new UUID)                            | Export while stopped; verify row counts after import        |
| `prod` R2 bucket        | `ai-moves-blobs`                                        | `ai-news-tracker-blobs`                                 | Copy all blobs before switching Worker bindings             |
| `prod` custom domain    | `moves.lineyahoo.dev`                                   | `moves.lineyahoo.dev` (or owner-chosen domain)          | Detach from `ai-moves-desk` before reattaching              |
| Queues (`dev` / `prod`) | `q-poll`, `q-triage`, `q-deep`, `q-deliver` (+ `-dev`)  | Unchanged                                               | No `ai-moves` prefix; detach legacy consumers before deploy |

**Queue consumer constraint**: Cloudflare Queues allow only one Worker consumer per queue. Remove the consumer link from the legacy pipeline Worker before deploying the renamed pipeline Worker to the same environment.

## Prerequisites

Obtain owner approval before creating Cloudflare resources, editing secrets, or touching `prod`.

- **CLI tools**: `gh`, `node_modules/.bin/wrangler` (4.166.0), and an S3-compatible sync tool (`rclone` or AWS CLI configured against `https://your_account_id.r2.cloudflarestorage.com`) or Cloudflare Dashboard R2 Super Slurper. `wrangler r2 object` has no copy subcommand and would need a `get` + `put` per key, with no recursive bucket sync.
- **Credentials**: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with D1, R2, Queues, and Workers permissions.
- **Pipeline Worker secrets**: values ready to upload with `wrangler secret put` for `HYPER_API_KEY`, `OPENROUTER_API_KEY`, `DISCORD_WEBHOOK_URL`, `TRIGGER_TOKEN`, and `GITHUB_TOKEN` (plus `MCP_TOKEN` if MCP is enabled; `MCP_SUBMITTER_NAME` is a plain Worker variable configured in `wrangler.jsonc`).

## Step 1: Rename the GitHub repository

Rename the GitHub repository first; both `.github/workflows/deploy.yml` and `.github/workflows/preview.yml` already accept `fang2hou/ai-news-tracker` alongside `fang2hou/ai-moves`.

1. Rename the repository via GitHub Settings or the GitHub CLI:

   ```bash
   gh repo rename ai-news-tracker -R fang2hou/ai-moves
   ```

2. Point local clones at the new remote URL and verify:

   ```bash
   git remote set-url origin git@github.com:fang2hou/ai-news-tracker.git
   git remote -v
   ```

3. Once the rename has settled, tighten the repository guard in `.github/workflows/deploy.yml` and `.github/workflows/preview.yml` from `contains(fromJSON('["fang2hou/ai-news-tracker", "fang2hou/ai-moves"]'), github.repository)` to `github.repository == 'fang2hou/ai-news-tracker'`.

## Step 2: Cut over Cloudflare `dev`

Run the full cutover on `dev` first to verify migrations, R2 sync, secrets, and **Desk PR Preview** before touching `prod`.

1. **Create target `dev` storage** matching the legacy D1 and R2 locations (location hints are fixed at creation), and record the new D1 UUID printed by `wrangler`. `wrangler d1 info` reports `running_in_region` and `wrangler r2 bucket info` reports `location` in upper case (for example `APAC`), while `--location` requires lower-case hints (for example `--location apac`):

   ```bash
   node_modules/.bin/wrangler d1 info ai-moves-dev
   node_modules/.bin/wrangler r2 bucket info ai-moves-blobs-dev

   node_modules/.bin/wrangler d1 create ai-news-tracker-dev --location location_hint
   node_modules/.bin/wrangler r2 bucket create ai-news-tracker-blobs-dev --location location_hint
   ```

2. **Export and import `dev` D1**: `wrangler d1 export` dumps all 14 tables in the migrated schema (the 12 active tables plus the retired legacy `budget_ledger` and `budget_charges` tables). Verify row counts across the 12 active tables before deleting the temporary dump:

   ```bash
   node_modules/.bin/wrangler d1 export ai-moves-dev --remote --output dev-export.sql
   node_modules/.bin/wrangler d1 execute ai-news-tracker-dev --remote --yes --file dev-export.sql

   ROW_COUNT_SQL="SELECT 'sources' AS t, COUNT(*) AS n FROM sources
   UNION ALL SELECT 'source_polls', COUNT(*) FROM source_polls
   UNION ALL SELECT 'items', COUNT(*) FROM items
   UNION ALL SELECT 'item_snapshots', COUNT(*) FROM item_snapshots
   UNION ALL SELECT 'item_revisions', COUNT(*) FROM item_revisions
   UNION ALL SELECT 'config_versions', COUNT(*) FROM config_versions
   UNION ALL SELECT 'analyses', COUNT(*) FROM analyses
   UNION ALL SELECT 'alerts', COUNT(*) FROM alerts
   UNION ALL SELECT 'destinations', COUNT(*) FROM destinations
   UNION ALL SELECT 'deliveries', COUNT(*) FROM deliveries
   UNION ALL SELECT 'audit_log', COUNT(*) FROM audit_log
   UNION ALL SELECT 'storage_migrations', COUNT(*) FROM storage_migrations;"

   node_modules/.bin/wrangler d1 execute ai-moves-dev --remote --json --command "$ROW_COUNT_SQL"
   node_modules/.bin/wrangler d1 execute ai-news-tracker-dev --remote --json --command "$ROW_COUNT_SQL"
   rm -f dev-export.sql
   ```

3. **Copy `dev` R2 blobs** from `ai-moves-blobs-dev` to `ai-news-tracker-blobs-dev` using your S3-compatible sync tool or R2 Super Slurper, then compare object counts:

   ```bash
   node_modules/.bin/wrangler r2 bucket info ai-moves-blobs-dev
   node_modules/.bin/wrangler r2 bucket info ai-news-tracker-blobs-dev
   ```

4. **Detach legacy `dev` queue consumers** so `ai-news-tracker-pipeline-dev` can bind to the `-dev` queues:

   ```bash
   for q in q-poll-dev q-triage-dev q-deep-dev q-deliver-dev; do
     node_modules/.bin/wrangler queues consumer remove "$q" ai-moves-pipeline-dev
   done
   ```

5. **Update `dev` bindings in the repository**:
   - `apps/pipeline/wrangler.jsonc` (`env.dev`): update `name` to `ai-news-tracker-pipeline-dev`, `vars.DESK_ORIGIN` to `https://ai-news-tracker-desk-dev.fang2hou.workers.dev`, `d1_databases[0]` to `ai-news-tracker-dev` and its new UUID, and `r2_buckets[0].bucket_name` to `ai-news-tracker-blobs-dev`. If MCP is enabled, set `vars.MCP_SUBMITTER_NAME` here too so `wrangler deploy` does not wipe a dashboard-only variable.
   - `apps/api/wrangler.jsonc` (`env.dev`): update `name` to `ai-news-tracker-desk-dev`, keep `"preview_urls": true`, and update `d1_databases[0]` to `ai-news-tracker-dev` and its new UUID.
   - `.github/workflows/deploy.yml`: update the non-prod `DATABASE` branch from `ai-moves-dev` to `ai-news-tracker-dev` (in both migration steps, lines 72 and 87).
   - `.github/workflows/preview.yml`: update the missing Version URLs error message to name `ai-news-tracker-desk-dev`.
   - `tools/local/card-json.ts`: update the fallback `DESK_URL` to `https://ai-news-tracker-desk-dev.fang2hou.workers.dev`.

6. **Update preview token permissions**: if `CLOUDFLARE_PREVIEW_API_TOKEN` in the GitHub `preview` environment is scoped to specific Workers, grant it access to `ai-news-tracker-desk-dev` before merging.

7. **Dry-run, upload secrets, and deploy `dev`**:

   ```bash
   VITE_LOCALE=zh-CN pnpm --filter @ai-news-tracker/web build
   node_modules/.bin/wrangler deploy --dry-run --config apps/pipeline/wrangler.jsonc --env dev
   node_modules/.bin/wrangler deploy --dry-run --config apps/api/wrangler.jsonc --env dev
   node_modules/.bin/wrangler versions upload --dry-run --config apps/api/wrangler.jsonc --env dev --preview-alias pr-9999
   ```

   Confirm the dry-run output prints `env.DB (ai-news-tracker-dev)`. Upload all Worker secrets to `ai-news-tracker-pipeline-dev` **before** its first deploy so no manual `/trigger` or queued `deliver` job can run without them (`wrangler secret put` creates a draft Worker if the name does not exist yet, confirming with a prompt that defaults to yes, and `wrangler deploy` preserves uploaded secrets):

   ```bash
   for key in HYPER_API_KEY OPENROUTER_API_KEY DISCORD_WEBHOOK_URL TRIGGER_TOKEN GITHUB_TOKEN; do
     node_modules/.bin/wrangler secret put "$key" --config apps/pipeline/wrangler.jsonc --env dev
   done
   ```

   Upload `MCP_TOKEN` as a secret if MCP submissions are enabled on `dev` (`MCP_SUBMITTER_NAME` must already be in `apps/pipeline/wrangler.jsonc` under `env.dev.vars`, because `wrangler deploy` clears dashboard-only variables unless `--keep-vars` is passed). Then merge to `main` (or trigger `deploy.yml` with `environment=dev`) to deploy `dev`.

8. **Verify `dev` and PR previews**:
   - Check `GET /healthz`, `GET /api/feed`, and `GET /api/heat` on `https://ai-news-tracker-desk-dev.fang2hou.workers.dev`.
   - Trigger one cycle with `POST https://ai-news-tracker-pipeline-dev.fang2hou.workers.dev/trigger` and header `x-trigger-token: your_trigger_token`.
   - Open or push to a same-repository PR and verify **Desk PR Preview** posts a working `pr-<number>` URL.

## Step 3: Cut over Cloudflare `prod`

1. **Stop production writes and drain in-flight work**:
   - **Mandatory first action**: disable the `*/5 * * * *` cron trigger on `ai-moves-pipeline` in the Cloudflare dashboard (**Workers & Pages** -> `ai-moves-pipeline` -> **Settings** -> **Trigger Events**), and pause any external `POST /mcp` callers if MCP is enabled. Keep `ai-moves-pipeline`'s cron trigger disabled throughout the entire 48- to 72-hour burn-in period so it never competes on shared `q-*` queues or mutates `ai-moves`.
   - **Do not set `delivery.paused: true`** during cutover or rollback: `global_pause` is a terminal suppression that permanently drops any due delivery processed while paused.
   - Poll until `items_inflight` and `deliveries_sending` both reach zero before exporting (`leases.deep_minutes` is 15 and model calls can run up to 180 seconds each; any remaining 4-minute poll lease in `polls_inflight` self-heals on the next tick if skipped):

   ```bash
   node_modules/.bin/wrangler d1 execute ai-moves --remote --json --command "
     SELECT 'items_inflight' AS t, COUNT(*) AS n FROM items WHERE state IN ('triaging', 'analyzing')
     UNION ALL
     SELECT 'deliveries_sending', COUNT(*) FROM deliveries WHERE state = 'sending'
     UNION ALL
     SELECT 'polls_inflight', COUNT(*) FROM source_polls WHERE owner IS NOT NULL;"
   ```

2. **Detach legacy `prod` queue consumers**:

   ```bash
   for q in q-poll q-triage q-deep q-deliver; do
     node_modules/.bin/wrangler queues consumer remove "$q" ai-moves-pipeline
   done
   ```

3. **Create target `prod` storage** matching the legacy D1 and R2 locations, and record the new D1 UUID. `wrangler d1 info` reports `running_in_region` and `wrangler r2 bucket info` reports `location` in upper case (for example `APAC`), while `--location` requires lower-case hints (for example `--location apac`):

   ```bash
   node_modules/.bin/wrangler d1 info ai-moves
   node_modules/.bin/wrangler r2 bucket info ai-moves-blobs

   node_modules/.bin/wrangler d1 create ai-news-tracker --location location_hint
   node_modules/.bin/wrangler r2 bucket create ai-news-tracker-blobs --location location_hint
   ```

4. **Export and import `prod` D1**: `wrangler d1 export` dumps all 14 tables in the migrated schema (the 12 active tables plus the retired legacy `budget_ledger` and `budget_charges` tables). Verify every active table matches row-for-row, then delete (or archive in encrypted storage) the local SQL dump:

   ```bash
   node_modules/.bin/wrangler d1 export ai-moves --remote --output prod-export.sql
   node_modules/.bin/wrangler d1 execute ai-news-tracker --remote --yes --file prod-export.sql

   ROW_COUNT_SQL="SELECT 'sources' AS t, COUNT(*) AS n FROM sources
   UNION ALL SELECT 'source_polls', COUNT(*) FROM source_polls
   UNION ALL SELECT 'items', COUNT(*) FROM items
   UNION ALL SELECT 'item_snapshots', COUNT(*) FROM item_snapshots
   UNION ALL SELECT 'item_revisions', COUNT(*) FROM item_revisions
   UNION ALL SELECT 'config_versions', COUNT(*) FROM config_versions
   UNION ALL SELECT 'analyses', COUNT(*) FROM analyses
   UNION ALL SELECT 'alerts', COUNT(*) FROM alerts
   UNION ALL SELECT 'destinations', COUNT(*) FROM destinations
   UNION ALL SELECT 'deliveries', COUNT(*) FROM deliveries
   UNION ALL SELECT 'audit_log', COUNT(*) FROM audit_log
   UNION ALL SELECT 'storage_migrations', COUNT(*) FROM storage_migrations;"

   node_modules/.bin/wrangler d1 execute ai-moves --remote --json --command "$ROW_COUNT_SQL"
   node_modules/.bin/wrangler d1 execute ai-news-tracker --remote --json --command "$ROW_COUNT_SQL"
   rm -f prod-export.sql
   ```

5. **Sync `prod` R2 blobs** from `ai-moves-blobs` to `ai-news-tracker-blobs` via R2's S3 API or Super Slurper, and compare counts with `node_modules/.bin/wrangler r2 bucket info`.

6. **Update `prod` configuration and docs in the repository**:
   - `apps/pipeline/wrangler.jsonc`: update top-level `name` and `env.prod.name` to `ai-news-tracker-pipeline`, `d1_databases[0]` to `ai-news-tracker` and its new UUID, `r2_buckets[0].bucket_name` to `ai-news-tracker-blobs`, and `vars.DESK_ORIGIN` if moving away from `moves.lineyahoo.dev`. If MCP is enabled, set `vars.MCP_SUBMITTER_NAME` under `env.prod.vars` so deploys retain it.
   - `apps/api/wrangler.jsonc`: update top-level `name` and `env.prod.name` to `ai-news-tracker-desk`, `d1_databases[0]` to `ai-news-tracker` and its new UUID, and `routes[0].pattern` if changing custom domains.
   - `.github/workflows/deploy.yml`: update the `prod` `DATABASE` branch from `ai-moves` to `ai-news-tracker` (in both migration steps, lines 72 and 87), and tighten the repository guard from Step 1 if not done earlier.
   - `tools/local/seed-sql.ts`: update the header comment database name to `ai-news-tracker`.
   - Remove legacy Phase 1 resource notes from [README.md](../README.md), [ARCHITECTURE.md](../ARCHITECTURE.md), [DEVELOPMENT.md](../DEVELOPMENT.md), [docs/deployment.md](./deployment.md), [docs/b4-operations-runbook.md](./b4-operations-runbook.md), [apps/api/README.md](../apps/api/README.md), and [tools/local/README.md](../tools/local/README.md), and mark [this runbook](./rename-migration.md) as executed.

7. **Detach the custom domain**: if keeping `moves.lineyahoo.dev`, remove it from `ai-moves-desk` in the Cloudflare dashboard (**Workers & Pages** -> `ai-moves-desk` -> **Settings** -> **Domains & Routes**) before deploying `ai-news-tracker-desk` so domain attachment does not conflict.

8. **Dry-run, upload secrets, and deploy `prod`**:

   ```bash
   VITE_LOCALE=zh-CN pnpm --filter @ai-news-tracker/web build
   node_modules/.bin/wrangler deploy --dry-run --config apps/pipeline/wrangler.jsonc --env prod
   node_modules/.bin/wrangler deploy --dry-run --config apps/api/wrangler.jsonc --env prod
   ```

   Confirm `env.DB (ai-news-tracker)`. Upload all secrets to `ai-news-tracker-pipeline` **before** its first deploy (`wrangler secret put` creates a draft Worker when the name does not exist yet, confirming with a prompt defaulting to yes, and `wrangler deploy` preserves uploaded secrets):
   - `SECRET_MISSING` is a permanent failure (`packages/contracts/src/errors.ts`) that moves any due delivery straight to `failed_permanent` instead of retrying or deferring it.
   - Neither `ai.enabled: false` (which pauses only triage, deep, and relevance work, not `sweep` or `deliver`) nor a post-deploy cron disable closes the gap before secrets exist. Keep `delivery.paused` set to `false` as well.

   ```bash
   for key in HYPER_API_KEY OPENROUTER_API_KEY DISCORD_WEBHOOK_URL TRIGGER_TOKEN GITHUB_TOKEN; do
     node_modules/.bin/wrangler secret put "$key" --config apps/pipeline/wrangler.jsonc --env prod
   done
   ```

   Upload `MCP_TOKEN` as a secret if MCP submissions are enabled in `prod` (`MCP_SUBMITTER_NAME` must already be in `apps/pipeline/wrangler.jsonc` under `env.prod.vars`). Then deploy `prod` via GitHub Actions `workflow_dispatch` or a GitHub Release.

9. **Smoke-test `prod`**:
   - Verify `GET /healthz`, `/`, `/heat`, `/api/feed`, and `/api/heat` on `https://moves.lineyahoo.dev` (or the new custom domain).
   - Inspect the next 5-minute cron tick in Workers Observability for clean `pipeline.dispatch.ready` and `pipeline.poll.result` metric samples with zero `CONFIG_INVALID` or `SECRET_MISSING` errors.

### Updating configuration versions safely

`AppConfigSchema` is strict and fails closed with `CONFIG_INVALID` if any partial object or unknown top-level key is stored. Always insert a complete valid configuration JSON row into `config_versions`:

1. Read the current configuration row:

   ```bash
   node_modules/.bin/wrangler d1 execute <database> --remote --json \
     --command "SELECT version, config_json FROM config_versions ORDER BY version DESC LIMIT 1"
   ```

2. Edit `config_json` locally, keep every required field intact, and insert the full JSON as the next version (replacing `full_valid_config_json` with single quotes escaped as `''` and `1764320000000` with the current Unix epoch milliseconds):

   ```bash
   node_modules/.bin/wrangler d1 execute <database> --remote --yes \
     --command "INSERT INTO config_versions (version, config_json, created_at, created_by)
   SELECT COALESCE(MAX(version), 0) + 1, 'full_valid_config_json', 1764320000000, 'operator'
   FROM config_versions;"
   ```

3. Verify on the next cron tick (or `POST /trigger` on `dev`) that no `CONFIG_INVALID` error is logged. If `CONFIG_INVALID` appears, recover by re-inserting the prior valid `config_json` at `MAX(version) + 1` (or deleting the bad top version row if no `analyses` row references it).

## Step 4: Rollback

Keep all legacy `ai-moves-*` Workers, D1 databases, and R2 buckets intact for a 48- to 72-hour burn-in period. Any rows written to `ai-news-tracker` after cutover are abandoned if you roll back. If `prod` fails after cutover:

1. Disable `ai-news-tracker-pipeline`'s cron trigger FIRST in the Cloudflare dashboard (do not set `delivery.paused: true`, which would permanently suppress due deliveries in `ai-news-tracker`).
2. Revert the Phase 2 infrastructure-rename commit(s) touching `apps/pipeline/wrangler.jsonc`, `apps/api/wrangler.jsonc`, `.github/workflows/deploy.yml`, `.github/workflows/preview.yml`, and `tools/local/card-json.ts` so a subsequent push or release cannot re-deploy `ai-news-tracker-*`:

   ```bash
   git revert phase2_rename_commit_sha
   ```

3. Detach the four queues from `ai-news-tracker-pipeline` and reattach them to `ai-moves-pipeline` with the production consumer settings from `apps/pipeline/wrangler.jsonc`:

   ```bash
   for q in q-poll q-triage q-deep q-deliver; do
     node_modules/.bin/wrangler queues consumer remove "$q" ai-news-tracker-pipeline
   done

   node_modules/.bin/wrangler queues consumer add q-poll ai-moves-pipeline --batch-size 10 --max-concurrency 2 --message-retries 3
   node_modules/.bin/wrangler queues consumer add q-triage ai-moves-pipeline --batch-size 10 --max-concurrency 2 --message-retries 3
   node_modules/.bin/wrangler queues consumer add q-deep ai-moves-pipeline --batch-size 1 --max-concurrency 2 --message-retries 3
   node_modules/.bin/wrangler queues consumer add q-deliver ai-moves-pipeline --batch-size 10 --max-concurrency 1 --message-retries 3
   ```

4. Detach the custom domain from `ai-news-tracker-desk` and reattach it to `ai-moves-desk`.
5. Re-enable `ai-moves-pipeline`'s cron trigger. Reconcile any alerts delivered during the failed window before re-enabling so Discord does not receive duplicate cards.

## Step 5: Retire legacy resources

After the 48- to 72-hour burn-in period of clean `prod` operation, delete the legacy `ai-moves-*` resources:

1. Delete legacy Workers:

   ```bash
   node_modules/.bin/wrangler delete ai-moves-pipeline-dev
   node_modules/.bin/wrangler delete ai-moves-desk-dev
   node_modules/.bin/wrangler delete ai-moves-pipeline
   node_modules/.bin/wrangler delete ai-moves-desk
   ```

2. Optionally keep an encrypted backup of `ai-moves`, then delete the legacy D1 databases, empty both legacy R2 buckets, and delete them:

   ```bash
   node_modules/.bin/wrangler d1 delete ai-moves-dev --skip-confirmation
   node_modules/.bin/wrangler d1 delete ai-moves --skip-confirmation
   # Empty both buckets first (via R2 S3 API or Dashboard) before deleting them.
   node_modules/.bin/wrangler r2 bucket delete ai-moves-blobs-dev
   node_modules/.bin/wrangler r2 bucket delete ai-moves-blobs
   ```

3. Remove `ai-moves-desk-dev` from `CLOUDFLARE_PREVIEW_API_TOKEN`'s Worker scope if the token was scoped by Worker name.

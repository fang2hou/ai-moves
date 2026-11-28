# Local tools

Scripts for running the pipeline on this machine and for preparing deployments. Nothing here deploys a Worker or creates a Cloudflare resource.

| Script              | Calls a model | What it does                                                                                                                                                 |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run.ts`            | Yes           | Runs the real pipeline Worker and desk in Miniflare against the live sources and model provider                                                              |
| `probe-model.ts`    | Yes           | Sends the real submission review request to each model in `PROBE_MODELS` to check strict JSON-schema output                                                  |
| `probe-deep.ts`     | Yes           | Runs the real deep prompt over the newest Antigravity release against each model in `PROBE_MODELS`                                                           |
| `schema-sql.ts`     | No            | Prints the storage migrations as one SQL script; `--applied <file>` keeps only unrecorded ones (used by the deploy workflow)                                 |
| `seed-sql.ts`       | No            | Prints the SQL for a fresh database's rows (configuration, sources, Discord destination); applying it is a manual step, not part of the deploy workflow      |
| `seed-dynamodb.ts`  | No            | Writes the same seed rows to a DynamoDB table through the storage adapter; existing rows are kept, and the configuration is published only to an empty table |
| `dynamodb-table.ts` | No            | Prints the DynamoDB table the storage adapter expects as an `AWS::DynamoDB::Table` resource (`TABLE_NAME` sets its name)                                     |
| `card-json.ts`      | No            | Prints the Discord payload for a stored document, read from a desk's public API (`DESK_URL`, default the `dev` desk)                                         |
| `discord-mock.mjs`  | No            | A zero-dependency local Discord stand-in                                                                                                                     |

Run the three model-calling scripts only when the owner asks. Each run calls the live provider: the default `run.ts` route is a free model, but its fallbacks and any probed model can be billed. Only the routes listed in `run.ts` and `seed.ts` are approved for this project.

Both seed scripts build their rows in `seed.ts`. `SEED_OUTPUT_LANG` (`en`, `zh-CN`, or `ja`; default `zh-CN`) sets `profile.output_lang` and the destination language, `SEED_CHANNEL` (`discord` or `slack`; default `discord`) picks the destination and the webhook secret it names, and `SEED_LLM` (`openrouter`, `hyper`, or `bedrock`; default `openrouter`) picks the model routes. `seed-dynamodb.ts` reads `TABLE_NAME` and the standard AWS variables. `AWS_ENDPOINT_URL_DYNAMODB` points it at DynamoDB Local.

`SEED_LLM=hyper` selects DeepSeek V4.1 Flash Economy, then the standard Flash model on Hyper. Triage uses low effort. Deep, translate, and polish use high effort. Eligible failures can switch to the OpenRouter seed route and its model chain. See the [fallback rules](../../packages/llm/README.md#cross-provider-fallback).

The seed writes the [calibrated HN defaults](../../packages/core/README.md#hacker-news-scoring), including `hn.activity`, into the initial configuration version. Older stored versions receive the activity defaults at parse time. To override stored thresholds, publish a new configuration version. Use the seed only for a fresh database.

## Setup

```bash
mise install
pnpm install --frozen-lockfile
mise run build-web                    # the desk assets the local Worker serves
```

Keep an OpenRouter key and a GitHub token outside the repository, for example `~/.test/openrouter.key` and `~/.test/github.key`. The GitHub token needs no scopes beyond public repository reads.

## Run the pipeline locally

Start the Discord stand-in first, then the pipeline and desk:

```bash
pnpm --filter @ai-news-tracker/local-demo discord

OPENROUTER_API_KEY="$(tr -d '\n' < ~/.test/openrouter.key)" \
GITHUB_TOKEN="$(tr -d '\n' < ~/.test/github.key)" \
STATE_DIR=.local-state \
pnpm --filter @ai-news-tracker/local-demo start
```

| URL                      | What it is                                    |
| ------------------------ | --------------------------------------------- |
| `http://localhost:8787/` | The desk; public, no sign-in                  |
| `http://localhost:7373/` | The Discord stand-in; new cards raise a toast |

Stop with `Ctrl+C`. With `STATE_DIR` set, the next start resumes from the same D1 and R2, so the sampling history survives a restart. Delivery is always live in the pipeline, so the runner keeps itself away from real destinations: it seeds none, and at startup it sets `dry_run` on any destination already in a persisted `STATE_DIR` (a dry-run delivery is recorded as sent without calling a notifier, and the runner binds no webhook secret). It posts a card to the stand-in itself whenever a new document appears.

## Environment

| Variable                        | Default                                                                                        | Purpose                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`            | unset                                                                                          | Without it, polling and scoring still run; analysis does not                 |
| `GITHUB_TOKEN`                  | unset                                                                                          | Without it, GitHub is read anonymously at its lower rate limit               |
| `OPENROUTER_TRIAGE_MODEL`       | `inclusionai/ling-3.2-flash-20261113:free`                                                     | Model for the triage route (submission review, HN relevance)                 |
| `OPENROUTER_DEEP_MODEL`         | `inclusionai/ling-3.2-flash-20261113:free`                                                     | Model for the deep and translate stages                                      |
| `OPENROUTER_FALLBACKS`          | `~deepseek/deepseek-flash-latest,tencent/hy4-flash-20261116,google/gemini-4-hydrogen-20261112` | Comma-separated fallback routes                                              |
| `STATE_DIR`                     | unset (memory only)                                                                            | Directory for the persisted D1 and R2                                        |
| `DESK_PORT`                     | `8787`                                                                                         | Desk port                                                                    |
| `POLL_INTERVAL_SEC`             | `300`                                                                                          | How often the scheduled handler runs                                         |
| `DISCORD_WEBHOOK_URL`           | `http://127.0.0.1:7373/api/webhooks/1/mock`                                                    | Where cards are posted                                                       |
| `DISCORD_MOCK_PORT`             | `7373`                                                                                         | Port for the stand-in                                                        |
| `DESK_ORIGIN`                   | `https://desk.example.test`                                                                    | Written into document links; must be HTTPS                                   |
| `DESK_LOCAL_URL`                | `http://localhost:8787`                                                                        | What the stand-in rewrites `DESK_ORIGIN` to, so a card is clickable          |
| `TRIAGE_TOKENS` / `DEEP_TOKENS` | `8000` / `32000`                                                                               | Output budgets; a reasoning model spends most of its budget before answering |
| `VERBOSE`                       | unset                                                                                          | `1` raises the Worker log level to `info` and prints every stage transition  |
| `DEEP_GATE_MIN_COMMENTS`        | unset                                                                                          | Overrides the HN deep gate; only useful when forcing an immediate analysis   |

The probes read `OPENROUTER_API_KEY` and `PROBE_MODELS` (comma-separated); `probe-model.ts` also reads `PROBE_ATTEMPTS`.

## What is watched

`run.ts` holds the same watchlist as `seed-sql.ts` and seeds one source row per entry on startup.

| Source                              | Polled every | How a change is found                         |
| ----------------------------------- | ------------ | --------------------------------------------- |
| Hacker News top 30                  | 5 min        | Rank, point, and comment deltas               |
| `can1357/oh-my-pi`                  | 10 min       | Releases, newest first                        |
| `stablyai/orca`                     | 10 min       | Releases, newest first                        |
| `earendil-works/pi`                 | 10 min       | Releases, newest first                        |
| `code.claude.com/docs/en/changelog` | 30 min       | New release sections in its Markdown twin     |
| `learn.chatgpt.com/docs/changelog`  | 30 min       | New release sections on the page              |
| `antigravity.google/docs/changelog` | 30 min       | New App and CLI releases in its Markdown twin |

## What to expect

A cycle runs every queued job before it ends. A changelog release published within `delivery.expiry_hours.changelog` (default 168 hours) becomes a candidate on its first read, so with a model key a changelog article can appear in the first cycle. Hacker News needs at least two samples for velocity, so no HN gate can fire before the second poll; a first HN article typically appears after three or four cycles. Run with `VERBOSE=1` to see each stage transition; a line with `retry_scheduled: true` means a stage failed and will be retried.

## Stand-in endpoints

`discord-mock.mjs` accepts `POST /api/webhooks/1/mock` with any JSON (`?wait=true` returns a receipt), serves the channel page at `GET /`, the raw history at `GET /messages`, and a server-sent stream at `GET /events`.

# Local operation

Runs the real pipeline Worker on a timer against the live Hacker News API and the
live model provider, serves the public desk, and pushes short cards to a Discord
stand-in. Nothing is deployed, no Cloudflare resource is created, and no real
Discord webhook is called.

The model calls cost money. Run anything in this directory only when the owner
asks.

## Setup

```bash
mise install
pnpm install --frozen-lockfile
pnpm --filter @ai-moves/web build      # the desk assets the Worker serves
```

Put an OpenRouter key and a GitHub token somewhere outside the repository, for
example `~/.test/openrouter.key` and `~/.test/github.key`. Never commit them.
The GitHub token needs no scopes beyond public repository reads.

## Run

Two processes. Start the Discord stand-in first:

```bash
pnpm --filter @ai-moves/local-demo discord
```

Then the pipeline and desk:

```bash
OPENROUTER_API_KEY="$(tr -d '\n' < ~/.test/openrouter.key)" \
GITHUB_TOKEN="$(tr -d '\n' < ~/.test/github.key)" \
STATE_DIR=.local-state \
pnpm --filter @ai-moves/local-demo start
```

| URL                      | What it is                                                    |
| ------------------------ | ------------------------------------------------------------- |
| `http://localhost:8787/` | The desk. Public: the feed and every article need no sign-in. |
| `http://localhost:7373/` | The Discord stand-in. New cards raise a toast.                |

Stop with `Ctrl+C`. With `STATE_DIR` set, the next start resumes from the same
D1 and R2, so the sampling history survives a restart.

## How it differs from a deployment

- The runner calls the scheduled handler directly, on its own timer. It does not
  go through `/trigger`, which is the manual entry of a deployed Worker.
- The configuration the runner publishes leaves `delivery.feed_only` at its
  default, so the pipeline plans no delivery. The runner itself posts the first
  document of each story to the stand-in (`notifyNewDocuments` in `run.ts`); it
  does not exercise the delivery consumer.
- A Hacker News story that already has a document is read again as its
  discussion grows, and the page then shows the latest reading. The stand-in
  gets no second card for it.
- Web pages are fetched through a pinned connection (see
  [the sources package](../../packages/sources/README.md#pinned-transport)). A
  deployed Worker fetches by hostname.

## Environment

| Variable                        | Default                                     | Purpose                                                                        |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY`            | unset                                       | Without it, polling and scoring still run; analysis does not.                  |
| `GITHUB_TOKEN`                  | unset                                       | Without it, release polling fails; Hacker News and doc changelogs still run.   |
| `OPENROUTER_TRIAGE_MODEL`       | a free route, named in `run.ts`             | Model for the triage stage.                                                    |
| `OPENROUTER_DEEP_MODEL`         | the same free route                         | Model for the deep stage. The polish pass and translation use the same route.  |
| `OPENROUTER_FALLBACKS`          | three routes, named in `run.ts`             | Comma-separated fallback routes.                                               |
| `STATE_DIR`                     | unset (memory only)                         | Directory for the persisted D1 and R2.                                         |
| `DESK_PORT`                     | `8787`                                      | Desk port.                                                                     |
| `POLL_INTERVAL_SEC`             | `300`                                       | How often the scheduled handler runs.                                          |
| `DISCORD_WEBHOOK_URL`           | `http://127.0.0.1:7373/api/webhooks/1/mock` | Where cards are posted.                                                        |
| `DISCORD_MOCK_PORT`             | `7373`                                      | Port for the stand-in.                                                         |
| `DESK_ORIGIN`                   | `https://desk.example.test`                 | Written into document links. See the note below.                               |
| `DESK_LOCAL_URL`                | `http://localhost:8787`                     | What the stand-in rewrites `DESK_ORIGIN` to, so a card is clickable.           |
| `TRIAGE_TOKENS` / `DEEP_TOKENS` | `8000` / `32000`                            | Output budgets. A reasoning model spends most of its budget before the answer. |
| `VERBOSE`                       | unset                                       | `1` raises the Worker log level to `info` and prints every stage transition.   |
| `DEEP_GATE_MIN_COMMENTS`        | unset                                       | Overrides the deep gate; only useful when forcing an immediate analysis.       |

The routes a deployment uses are not in this file. They are in the configuration
published to its database.

`DESK_ORIGIN` must be `https` because the product requires it of every published
link. A local desk is served over `http`, so the stand-in rewrites the prefix
when it renders a card. That rewrite is local only; the stored document keeps
the real origin.

## What is watched

`run.ts` holds the watchlist and seeds one source row per entry on startup.

| Source                              | Polled every | How a change is found            |
| ----------------------------------- | ------------ | -------------------------------- |
| Hacker News top 30                  | 5 min        | Rank, point, and comment deltas  |
| `can1357/oh-my-pi`                  | 10 min       | Releases, newest first           |
| `stablyai/orca`                     | 10 min       | Releases, newest first           |
| `earendil-works/pi`                 | 10 min       | Releases, newest first           |
| `code.claude.com/docs/en/changelog` | 30 min       | New release sections on the page |
| `learn.chatgpt.com/docs/changelog`  | 30 min       | New release sections on the page |
| `antigravity.google/docs/changelog` | 30 min       | New App and CLI releases         |

A documentation changelog carries every version of a product on one page, so the
page is split into releases and each release becomes its own item and its own
article. A page that groups its releases under product surfaces is followed one
surface at a time: Antigravity publishes app, CLI, SDK, IDE and extension releases
together, and only the app and the CLI are watched. The first read takes only the
newest release of each followed surface; later reads take whatever was published
above that surface's high-water mark. Where a site serves a Markdown
twin of the page it is polled instead of the rendered HTML, which is several
megabytes of application markup and would be truncated before the entries begin.

## What to expect

Nothing reaches the feed on the first cycle, by design. Heat is computed from
the change between consecutive samples, so a story needs at least two polls
five minutes apart before any gate can fire. A typical first article appears
after three or four cycles.

```
items tracking=30                                  published=0   # cycle 1
items tracking=29 triaged_reject=1                 published=0   # cycle 2, gate fired
items tracking=19 triaged_reject=10 triaged_pass=1 published=0   # cycle 3, triage ran
items tracking=29 feed_only=1                      published=1   # deep ran, card sent
```

Run with `VERBOSE=1` to see each stage transition. A line with
`retry_scheduled: true` means a stage failed and will be retried.

## Pieces

- `run.ts` — the runner described above.
- `discord-mock.mjs` — zero-dependency Discord stand-in. `POST` any JSON to
  `/api/webhooks/1/mock`; `?wait=true` returns a receipt. `GET /` is the channel
  page, `GET /messages` the raw history, `GET /events` a server-sent stream.
- `probe-deep.ts` — runs the real deep prompt over one release of a watched
  changelog against each model in `PROBE_MODELS`, and prints the summary, the
  points and the citation count. Each run is a paid call against the live
  provider: run it only when the owner asks, and only with the routes the owner
  names in `PROBE_MODELS`.
- `probe-model.ts` — sends a real triage request through the product's own
  OpenRouter client to check whether a model honours strict `json_schema`.
  `PROBE_MODELS` takes a comma-separated list, `PROBE_ATTEMPTS` a repeat count.
  Each attempt is a paid call, with the same rule.
- `card-json.ts` — prints the Discord payload for one document it reads from a
  desk's public API (`DESK_URL`, else the dev desk). Nothing is sent. It is not
  a package script: `node tools/local/card-json.ts [<id or title>]`.
- `schema-sql.ts` — prints the storage schema as one SQL script, for applying to
  a remote D1. `--applied <file>` narrows the output to the migrations that file
  does not list. The deploy workflow runs it (see
  [Development](../../DEVELOPMENT.md#deployment)).
- `seed-sql.ts` — prints the rows a fresh deployment needs: the published
  configuration, the sources to poll, and the Discord destination. It holds no
  secret; the destination names the `DISCORD_WEBHOOK_URL` binding.

```bash
PROBE_MODELS=<route>[,<route>...] \
OPENROUTER_API_KEY="$(tr -d '\n' < ~/.test/openrouter.key)" \
pnpm --filter @ai-moves/local-demo probe
```

# ADR-0007: An hourly cron and a manual trigger

- **Status**: Accepted
- **Date**: 2026-11-23 (written down on 2026-11-24, after the change had shipped)

## Context

The plan scheduled the pipeline every five minutes, locally and in production. A tick can end in paid model calls, so a schedule that runs by itself spends budget whether or not anyone is looking. A tick only dispatches the sources whose own interval is due, so a slower schedule costs freshness and nothing else (`apps/pipeline/wrangler.jsonc`). The owner also needed a way to check a new deployment without waiting for its next run.

## Decision

- **Production runs hourly.** The `prod` environment declares `"crons": ["0 * * * *"]` (`apps/pipeline/wrangler.jsonc`). It is deployed from a release (`.github/workflows/deploy.yml`).
- **Dev has no cron.** The `dev` environment declares none (`apps/pipeline/wrangler.jsonc`). It is deployed from `main` (`.github/workflows/deploy.yml`), and a run there is started by hand, so it never spends model budget on its own.
- **A tick can be run by hand.** `POST /trigger` with the header `x-trigger-token` equal to the `TRIGGER_TOKEN` secret runs exactly what the schedule runs and answers `{"ran":"scheduled","at":<ms>}` (`apps/pipeline/src/worker.ts`). Any other method, path or token answers `404 Not found`. The token has to be at least 16 characters and is compared in constant time. With no token configured there is no way in at all.

## Alternatives

- Keep five minutes in both environments. The dev deployment would then spend model budget with nobody watching it.
- A shorter interval for Hacker News only. The tick already dispatches only the sources that are due, so the interval of a source can be changed in the database without touching the schedule; the schedule sets the ceiling.
- Schedule the pipeline from a GitHub Action instead of a cron. That is one more place to look when a run does not happen.
- No manual trigger. A deployment could then only be checked by waiting for the cron.

## Consequences

- No source is polled more often than hourly in production. A tick dispatches each due source at most once (`dispatchDueSources` in `packages/ingestion/src/tick.ts`, `scheduleDue` in `packages/storage/src/d1.ts`), whatever its own `poll_interval_sec` says. The five-minute interval the seed gives Hacker News therefore means "due at every tick" (`tools/local/seed-sql.ts`).
- A Hacker News story is sampled at most once an hour in production.
- One tick does three things side by side: it dispatches due sources, refreshes published stories and sweeps stale work, each bounded to 100 rows (`TICK_LIMIT` in `apps/pipeline/src/worker.ts`).
- The trigger carries the same access as the cron and is guarded by the token alone. `TRIGGER_TOKEN` is not declared in `apps/pipeline/wrangler.jsonc`; it is a Worker secret. Both environments are reachable on a `workers.dev` address (`workers_dev: true`).
- The local demo keeps a timer of its own, five minutes by default (`POLL_INTERVAL_SEC` in `tools/local/run.ts`).

## Review Triggers

Revisit this decision when a source has to be polled more often than hourly, when a tick outlasts its schedule, or when the trigger has to run one source or one stage rather than a whole tick.

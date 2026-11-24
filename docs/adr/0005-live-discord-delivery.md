# ADR-0005: Live Discord delivery

- **Status**: Accepted. Supersedes [ADR-0003](./0003-initial-feed-only-rollout.md).
- **Date**: 2026-11-23 (written down on 2026-11-24, after the change had shipped)

## Context

[ADR-0003](./0003-initial-feed-only-rollout.md) held the pipeline at feed-only as an initial rollout, to be revisited before any real delivery. Since then the desk became public ([ADR-0004](./0004-public-desk-access-for-administration.md)), the Discord card was rewritten (`packages/delivery/src/render/discord.ts`), and the pipeline runs on Cloudflare. A card that arrives by itself serves the owner better than a feed that has to be checked, and the seed declares a single destination: a Discord webhook.

## Decision

- Sending is switched by the published configuration, not by code. The pipeline sends when `delivery.feed_only` is false (`apps/pipeline/src/worker.ts`). The schema default is still `true` (`packages/contracts/src/config.ts`), so a configuration that omits the key stays feed-only.
- With the switch off, a `send` decision plans one delivery per enabled, eligible destination (`planDeliveries` in `packages/delivery/src/finalize.ts`) and the `q-deliver` consumer executes it through the Discord webhook notifier (`apps/pipeline/src/worker.ts`). With the switch on, the consumer still fences pending rows as `suppressed` with the reason `rollout_feed_only`, as ADR-0003 described.
- A live card needs more than the switch. The destination has to be enabled, with the channel `discord` and the purpose `alerts`; `delivery.force_dry_run` and the destination's own `dry_run` have to be false; and its `secret_ref` has to name a secret bound on the Worker (`executeDelivery` in `packages/delivery/src/execute.ts`, `apps/pipeline/src/bindings.ts`). The webhook has to be on `discord.com` over HTTPS (`packages/delivery/src/notifiers/webhook.ts`).
- `tools/local/seed-sql.ts`, which prints the rows a fresh deployment needs, publishes `feed_only` and `force_dry_run` as false and one destination, `discord-main`, that names the secret `DISCORD_WEBHOOK_URL`.
- Slack is dormant. The Worker constructs a `slack` notifier next to the `discord` one and the package still renders Slack text (`packages/delivery/src/render/slack.ts`), but it exposes no secret a Slack destination could name (`apps/pipeline/src/bindings.ts`) and the seed declares no such destination.
- What ADR-0003 left standing still holds: an `unknown` outcome is terminal and is never resent ([ADR-0002](./0002-b2-durable-work.md)).

## Alternatives

- Stay feed-only, as ADR-0003 decided. The owner would have to check the desk to learn of a release.
- Add a review step before each send. That is a second product to build and run for one reader.
- Send unconditionally, with no switch in the configuration. Stopping would then need a deploy instead of a configuration publish.
- Delete the Slack code. Not done; whether to is an open question.

## Consequences

- Turning delivery off is a configuration publish, not a deploy. Rows that are already pending are fenced `suppressed` with `rollout_feed_only`, and nothing is backfilled.
- The seed raises the delivery settings for a personal feed: `daily_budget_per_destination` 25, `daily_cap_per_source` 10 for Hacker News and 15 for changelogs, and `min_interval_minutes` 0 (`tools/local/seed-sql.ts`). These are seed values; the code keeps lower schema defaults (`packages/contracts/src/config.ts`).
- A card is built only from a document that passes the link rules and matches the alert, the item and the destination's language. Anything else is suppressed as `unverified_content` before a budget is debited (`packages/delivery/src/execute.ts`).
- The four queue consumers in `apps/pipeline/wrangler.jsonc` declare a batch size and a concurrency. Platform retry limits and dead-letter queues are not configured there.

## Review Triggers

Revisit this decision when a second channel or destination is added, when delivery needs a review or an approval step, when a card has to be resent or backfilled, or when the delivery caps have to become limits in code rather than values in the configuration.

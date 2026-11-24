# AI Moves

Guidance for AI agents working in this strict-ESM TypeScript monorepo. AI Moves is a public desk at https://moves.lineyahoo.dev that tracks releases of AI coding tools and the Hacker News top 30, and it has one owner. Follow the shared [AI Coding Guidelines](https://github.com/fang2hou/ai-coding-guidelines); [ARCHITECTURE.md](./ARCHITECTURE.md) is the source of truth for project-specific boundaries.

## Commands

```bash
mise install
pnpm install --frozen-lockfile
mise run check                        # format check, lint, typecheck: the gate before every commit
pnpm --filter @ai-moves/web build     # the desk pages
pnpm --filter @ai-moves/api build     # the API Worker bundle
```

Use pnpm, not npm or yarn. There is no test suite and no test task ([ADR-0008](./docs/adr/0008-static-checks-instead-of-a-test-suite.md)).

## Layout

- `apps/pipeline` is the hourly cron and the queue consumers; `apps/api` is the Hono Worker that serves the desk's API and the pages that Vite builds from `apps/web`; `tooling` holds the shared TypeScript configuration and the lint boundaries.
- `packages/contracts` holds the shared contracts, schemas, state, ports and errors; `packages/kernel` the deterministic runtime behavior; `packages/core` the scoring, send policy and idempotency keys; `packages/prompts` the model templates; `packages/storage`, `packages/sources`, `packages/llm` and `packages/runtime-cloudflare` adapt D1, Hacker News, GitHub, the web, OpenRouter and the Cloudflare bindings.
- `packages/ingestion` polls and recovers; `packages/analysis` triages, analyzes, polishes and finalizes; `packages/delivery` sends and renders cards; `tools/local` is the local demo, the paid probes and the SQL rendered for a deployment; `docs/` holds the ADRs, the link rules and the archive.

## Product

- The desk is public. Only `/api/admin/*` and `/api/session` check Cloudflare Access; with no `ACCESS_*` bindings, as deployed, they fail closed and the admin view in `apps/web` cannot be reached ([ADR-0004](./docs/adr/0004-public-desk-access-for-administration.md)).
- Discord delivery is on when the published configuration has `delivery.feed_only` set to false. Slack is dormant ([ADR-0005](./docs/adr/0005-live-discord-delivery.md)).
- A document is written in one language, repaired by a second model pass, and a Hacker News story is read again as its discussion grows ([ADR-0006](./docs/adr/0006-living-documents-and-the-refresh-pass.md)).
- Production runs hourly, dev has no cron, and `POST /trigger` with the `x-trigger-token` header runs one tick by hand ([ADR-0007](./docs/adr/0007-hourly-cron-and-manual-trigger.md)).
- Model routes and every other setting live in the configuration published to D1, not in code or in these documents. The deployed web egress is a plain `fetch` after a DNS check (`apps/pipeline/src/egress.ts`), not a pinned connection.

## Boundaries

Always:

- Keep domain logic independent of Cloudflare and provider SDKs: network and platform access stay in the adapters that `tooling/src/boundaries.ts` names, and workspace packages are imported through their declared public subpaths, never through barrel files.
- Regenerate `.oxlintrc.json` with `pnpm lint:config` after changing `tooling/src/boundaries.ts` or `tooling/src/oxlint-config.ts`; never hand-edit it.
- Verify a behavior change by running it: a throwaway script that Node runs directly, with fakes and never a real service.
- Update documentation in the same change when setup, behavior, commands, or architecture changes.

Never:

- Commit secrets or production credentials.
- Push directly to `main`.
- Add a test framework or a test suite, or a dependency without documenting why the existing toolchain cannot meet the requirement.
- Call a model provider, deploy, or touch a remote database or bucket unless the owner asked. The scripts under `tools/local/` cost money.

Ask first:

- Changes to invariants in `ARCHITECTURE.md`, a new dependency, or the wording a reader sees on the desk or in a Discord card.
- Production deployment, Cloudflare resource creation, migrations, or credential changes.
- Destructive history operations or shared-branch force pushes.

## Confirmed Language Policy

| Item                                 | Value                      |
| ------------------------------------ | -------------------------- |
| Conversation                         | Follow the user's language |
| Code, comments, and commits          | English                    |
| Repository documentation             | English                    |
| Product UI text and published output | Simplified Chinese         |
| Tone                                 | Technical and concise      |

Do not infer the UI language from the conversation language; record any future change here. The desk and every published document are Simplified Chinese as of 2026-11-23, set by `profile.output_lang`. Analysis writes in that language directly; citation quotes stay verbatim in the language of their source.

## Project Conventions

- Model failures with `AppError` and the error codes in `@ai-moves/contracts/errors`.
- Make the smallest complete change, and add no abstraction before a second caller needs it.
- Depth: [DEVELOPMENT.md](./DEVELOPMENT.md) for workflow, [CONTRIBUTING.md](./CONTRIBUTING.md) for review requirements, and [ARCHITECTURE.md](./ARCHITECTURE.md) for invariants.

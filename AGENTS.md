# AI Moves

Guidance for AI agents working in this local-first TypeScript monorepo.

## Commands

```bash
mise install
pnpm install --frozen-lockfile
mise run check
mise run test
pnpm --filter @ai-moves/contracts test
pnpm --filter @ai-moves/kernel test
pnpm --filter @ai-moves/testing test
pnpm lint:config
```

Use pnpm, not npm or yarn. Run `mise run check` before every commit and `mise run test` for the full suite.

## Engineering Standards

Follow the shared [AI Coding Guidelines](https://github.com/fang2hou/ai-coding-guidelines) and this repository's `ARCHITECTURE.md`. The repository documentation is the source of truth for project-specific boundaries.

## Layout

- `apps/` — deployable composition roots.
- `packages/contracts/` — shared runtime contracts, schemas, state, ports, and errors.
- `packages/kernel/` — shared deterministic runtime behavior and failure handling.
- `packages/testing/` — reusable fakes, contract suites, fixtures, and upstream mocks.
- `tooling/` — shared TypeScript, Vitest, and generated lint configuration.
- `docs/` — architecture and implementation decisions.

## Boundaries

Always:

- Keep domain logic independent of Cloudflare and provider SDKs.
- Import workspace packages through their declared public subpaths.
- Regenerate `.oxlintrc.json` with `pnpm lint:config` after changing `tooling/src/boundaries.ts` or `tooling/src/oxlint-config.ts`.
- Update documentation in the same change when setup, behavior, commands, or architecture changes.

Never:

- Commit secrets or production credentials.
- Push directly to `main`.
- Hand-edit `.oxlintrc.json`; regenerate it.
- Add a dependency without documenting why the existing toolchain cannot meet the requirement.

Ask first:

- Changes to invariants in `ARCHITECTURE.md`.
- Production deployment, Cloudflare resource creation, migrations, or credential changes.
- Destructive history operations or shared-branch force pushes.

## Confirmed Language Policy

| Item                                 | Value                      |
| ------------------------------------ | -------------------------- |
| Conversation                         | Follow the user's language |
| Code, comments, and commits          | English                    |
| Repository documentation and UI text | English                    |
| Tone                                 | Technical and concise      |

Do not infer the UI language from the conversation language; record any future change here.

## Project Conventions

- Use ESM and strict TypeScript.
- Import from defining modules or declared package subpaths; do not add barrel files.
- Model failures with `AppError` and the error codes in `@ai-moves/contracts/errors`.
- Tests verify meaningful behavior and are deterministic; network access is blocked unless explicitly injected.

Depth: [DEVELOPMENT.md](./DEVELOPMENT.md) for workflow, [CONTRIBUTING.md](./CONTRIBUTING.md) for review requirements, and [ARCHITECTURE.md](./ARCHITECTURE.md) for invariants.

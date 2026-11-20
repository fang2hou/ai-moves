# Development

This guide covers repository setup, workflows, and validation for humans and AI agents. Product-facing setup is in [README.md](./README.md).

## Setup

All runtime and project CLI versions are managed by mise.

```bash
mise install
pnpm install --frozen-lockfile
```

| Tool       | Purpose                              | Managed via           |
| ---------- | ------------------------------------ | --------------------- |
| Node.js 24 | Runtime                              | `mise.toml`           |
| pnpm 12    | Workspace and package manager        | `mise.toml`           |
| prek       | Pre-commit checks                    | `mise.toml`           |
| TypeScript | Type checking and declaration builds | `pnpm-workspace.yaml` |
| oxlint     | Lint and type-aware rules            | `pnpm-workspace.yaml` |
| oxfmt      | Formatting                           | `pnpm-workspace.yaml` |
| Vitest     | Tests                                | `pnpm-workspace.yaml` |

Do not replace a pinned tool without an explicit project decision.

## Commands

```bash
mise run format
mise run format-check
mise run lint
mise run typecheck
mise run check
mise run test
pnpm --filter <package> <script>
```

`mise run check` is the same static validation entry point used by CI. `mise run test` depends on `check`, so tests never run on unvalidated code.

## Workflow

1. Create a focused feature branch from the current integration branch.
2. Read `ARCHITECTURE.md` and the relevant package sources.
3. Make the smallest complete change for the requirement.
4. Add behavior-focused regression coverage for failure paths or uncertain boundaries.
5. Run `pnpm lint:config` when dependency boundaries change.
6. Run `mise run check`, then `mise run test`.
7. Run `prek run --all-files` before the commit.
8. Commit with a Conventional Commit and open a pull request.

## Layout

- `packages/contracts` owns shared domain schemas and port interfaces.
- `packages/kernel` owns framework-independent runtime infrastructure.
- `packages/testing` owns deterministic test doubles, contract suites, and fixture tooling.
- `tooling` owns generated lint boundaries and shared build and test presets.
- `apps` will contain deployable composition roots once application slices begin.

## Coding Standards

- Use strict TypeScript and ESM.
- Use standard English for identifiers, comments, configuration names, and commits.
- Prefer direct imports from the defining module or an explicit package subpath.
- Use `AppError` rather than unclassified native errors in bounded application code.
- Keep comments sparse; explain only non-obvious invariants, hazards, or rationale.
- Avoid dependencies, abstractions, and modules without a concrete current use case.

## Testing

- Run a package test with `pnpm --filter @ai-moves/<package> test -- <file>`.
- Test behavior at the schema, port, or public API boundary.
- Keep tests deterministic; inject clocks, IDs, failures, and network clients.
- The shared Vitest setup blocks unapproved network access.
- Run `@ai-moves/testing/contract/storage` against a fresh backend per case.
  Register `storedItemRowContract` separately for backends that decode stored rows.
- For runtime adapters, run the job bus suite with an injected send failure and
  run the secret and telemetry suites with synthetic bindings and a local sink.
- Script source and LLM doubles through `@ai-moves/testing/fakes/{hn,github,web,llm}`.
  Each invocation consumes one scripted outcome and records its arguments.

### Local Worker and D1 tests

For D1-only tests, import `createLocalD1` from `@ai-moves/testing/test/d1`
and call `await createLocalD1(applyStorageMigrations)` from a composition test
allowed to import the storage adapter. Add a test project reference to
`packages/testing/tsconfig.test.json`. The callback supplies setup without a
dependency from `testing` back to `storage`. Use the returned `database` and
call `dispose()` in `finally` or contract teardown.

For Worker binding tests, use the catalog-pinned `miniflare` and `@cloudflare/workers-types`
as dev dependencies where the platform boundary permits them. The in-memory fakes do not exercise Worker bindings
or D1 transactions; Miniflare does without the Wrangler CLI, a Cloudflare account,
or a remote database. The type pin matches Miniflare's `workerd` release. `workerd`
uses its prebuilt platform package, so pnpm does not run its install script.

Create a fresh, non-persistent emulator on loopback, reject outbound requests, and
dispose it in `finally` or the contract harness teardown. Keep emulation out of
runtime code. Local tests do not establish production quota or queue-redelivery behavior.

## Validation

The main local and CI validation sequence is:

```bash
mise run check
mise run test
pnpm install --frozen-lockfile
prek run --all-files
```

CI installs the same toolchain from `mise.toml`, installs from the frozen lockfile, then calls the shared mise tasks.

## Deferred Git Governance

Credential scanning, `.gitattributes`, Cocogitto checks, pull-request title validation, and a final GitHub Actions pinning policy remain follow-up work. They must land through a dedicated Git-only pull request; they are not implied by the current static checks.

## Deployment

No production deployment workflow exists. Creating Cloudflare resources, applying migrations, writing credentials, enabling outbound delivery, or deploying requires explicit human approval at the operation boundary.

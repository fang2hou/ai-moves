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

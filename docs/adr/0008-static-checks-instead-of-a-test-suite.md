# ADR-0008: Static checks instead of a test suite

- **Status**: Accepted. Supersedes the validation bullet of [ADR-0001](./0001-b1-package-boundaries.md).
- **Date**: 2026-11-23 (written down on 2026-11-24, after the change had shipped)

## Context

The repository was built with a test framework: a suite per package, a shared test-support package of fakes, contract suites and recorded fixtures, and a local Worker emulator, all run by a `test` task that CI called on every change. The [acceptance report](../archive/b5-local-acceptance.md) and the [rollout checklist](../archive/b5-rollout-checklist.md) record what that suite proved. On 2026-11-23 the owner removed the suites and their configuration (commit `2fee51e`) and the test wiring of the remaining packages (commit `2325450`). AI Moves is a personal project with one operator, and the owner removed the suite rather than keep it maintained.

## Decision

- There is no test suite and no test framework. A change does not add either.
- The gate is static. `mise run check` runs the format check, the linter and the type check (`mise.toml`). CI then builds the desk and the API Worker (`.github/workflows/ci.yml`), and the deploy workflow bundles both Workers in a dry run before it touches a database (`.github/workflows/deploy.yml`).
- A behavior change is verified by running it. A throwaway script that Node runs directly (`node some-file.ts`, with Node 26 stripping the types) drives the real function with fakes or fixtures and never with a real service, and is deleted before the commit. The scripts under `tools/local/` run the real pipeline against live providers and cost money, so they run only when the owner asks.
- The generated lint boundaries stay (`tooling/src/boundaries.ts`). They are static checks, and they hold the package rules of ADR-0001.

## Alternatives

- Keep a reduced suite. That is still a framework, fixtures and an emulator to maintain with every change.
- Check the deployed desk from CI. That reads production data and proves little about failure paths.
- Rely on types alone. Types do not run, so they cannot show what a change does. Hence "run it".

## Consequences

- Nothing fails a pull request for a behavior regression. A regression shows up on the desk, in Discord or in the Worker logs, and the owner is the one who sees it.
- `apps/pipeline` has no build script (`apps/pipeline/package.json`), so CI covers it with the static checks only. Only the deploy workflow's dry run bundles it.
- Clocks, IDs, network clients and failures enter through ports, so a throwaway script can drive a real function without a network.
- The package boundaries, the error model and the strict types carry more of the safety than they did before. A change that weakens one of them costs more than it appears to.
- The archived acceptance report describes evidence that no longer exists. It is history, not a baseline to return to.

## Review Triggers

Revisit this decision when the project gains a second operator, when outside readers depend on data it must not lose, when one place breaks in production twice, or when a change is too large to be checked by running it once.

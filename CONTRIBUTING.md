# Contributing

This document covers how a change lands. Start with [DEVELOPMENT.md](./DEVELOPMENT.md) for setup and [AGENTS.md](./AGENTS.md) for agent-specific rules.

## Ground Rules

- Make the smallest complete change that solves the requirement.
- Keep one logical change per pull request.
- Do not mix unrelated cleanup into a feature or remediation.
- Add dependencies only with a concrete requirement and a reviewable rationale.
- Do not include secrets, credentials, or sensitive production data.

## Reporting a Bug

Search existing issues first. Include a minimal reproduction, observed behavior, expected behavior, runtime version, and relevant logs after redaction.

## Proposing a Feature

Open an issue before implementation when the request changes external behavior, cost, security, or an architecture invariant. Include the user need, constraints, expected outcome, and non-goals.

## Pull Request Workflow

1. Branch from `main`; never push directly to `main`.
2. Implement the focused change and update relevant documentation.
3. Run `mise run check`, `pnpm --filter @ai-moves/web build`, and `pnpm --filter @ai-moves/api build`. The repository has no unit-test suite.
4. Run `prek run --all-files` and review the staged diff.
5. Commit with Conventional Commits and open a pull request.
6. Resolve review findings and merge only after the `Verify` CI check passes.

## Review Expectations

Reviewers verify:

- Correctness of requested behavior and failure handling.
- No accidental scope, files, dependencies, or generated changes.
- Compatibility with `ARCHITECTURE.md`, package boundaries, and existing ADRs.
- Testing evidence in the description that matches what the change touches.
- Documentation updated in the same change when setup, commands, behavior, or architecture changes.
- No secrets, sensitive data, or platform coupling outside the adapters and composition roots.

## Commit Conventions

Use Conventional Commits in English:

```text
feat(contracts): validate calendar dates
fix(ingestion): keep the cursor when a page does not split
refactor(kernel): expose explicit entry points
```

The pull request title must use the same convention when squash merge derives the final commit message.

## Pull Request Descriptions

Every pull request description must include:

- **Purpose**: why the change exists.
- **Impact**: packages, behavior, and consumers affected.
- **Context**: requirements, decisions, or incidents behind it.
- **Risks**: possible regressions, compatibility concerns, or follow-up work.
- **Testing**: exact validation commands and outcomes.

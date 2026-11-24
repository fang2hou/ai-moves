# Contributing

This document covers how a change lands. Start with [DEVELOPMENT.md](./DEVELOPMENT.md) for setup and [AGENTS.md](./AGENTS.md) for agent-specific rules.

## Ground Rules

- Make the smallest complete change that solves the requirement.
- Keep one logical change per pull request.
- Do not mix unrelated cleanup into a feature or remediation.
- Add a dependency only with a concrete requirement and a reviewable rationale, and ask the owner first.
- Do not include secrets, credentials, or sensitive production data.

## Reporting a Bug

Search existing issues first. Include a minimal reproduction, observed behavior, expected behavior, the environment (`dev` or `prod`), and relevant logs after redaction.

## Proposing a Feature

Open an issue before implementation when the request changes external behavior, cost, security, or an architecture invariant. Include the user need, constraints, expected outcome, and non-goals.

## Pull Request Workflow

1. Branch from `main`; never push directly to `main`.
2. Implement the focused change and update the documentation it makes false.
3. Verify the behavior by running it, as [Validation](./DEVELOPMENT.md#validation) describes.
4. Run `mise run check`, and the build of whatever you changed.
5. Review the staged diff, commit with a Conventional Commit, and open a pull request against `main`.
6. Resolve review findings and merge only after required checks pass.

Every push to `main` deploys the `dev` environment, so a merge is a deployment (see [Deployment](./DEVELOPMENT.md#deployment)).

## Review Expectations

Reviewers verify:

- Correctness of requested behavior and failure handling.
- No accidental scope, files, dependencies, or generated changes.
- Compatibility with `ARCHITECTURE.md`, package boundaries, and existing ADRs.
- What the author ran to verify the change, and that it used no real service unless the owner asked for one. There is no test suite to extend ([ADR-0008](./docs/adr/0008-static-checks-instead-of-a-test-suite.md)).
- Documentation that the change made false is updated in the same change.
- No secrets, sensitive data, or unsupported platform coupling.

## Commit Conventions

Use Conventional Commits in English:

```text
feat(pipeline): read documentation changelogs and rewrite the reading
fix(storage): minimize durable delivery error summaries
docs(operations): record B5 local acceptance
```

The pull request title must use the same convention when squash merge derives the final commit message.

## Pull Request Descriptions

Every pull request description must include:

- **Purpose**: why the change exists.
- **Impact**: packages, behavior, and consumers affected.
- **Context**: requirements, decisions, or incidents behind it.
- **Risks**: possible regressions, compatibility concerns, or follow-up work.
- **Testing**: exact validation commands and outcomes.

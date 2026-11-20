# Architecture

AI Moves is a monorepo for a local-first monitoring pipeline that turns selected external activity into reviewable alerts. Domain contracts, deterministic infrastructure, platform adapters, and deployable assembly roots are separated so providers and runtimes can change without rewriting domain logic.

## Overview

The implementation is intended to expose two deployment units: a scheduled and queue-driven pipeline, plus a read-only and administrative API with static web assets. Shared contracts define all cross-package state and ports; component packages depend on ports, while platform adapters implement them at the deployment edge.

## Codebase Map

- `packages/contracts` — entities, state models, messages, ports, schemas, configuration, and error codes.
- `packages/kernel` — deterministic clocks and IDs, boundaries, configuration loading, errors, logging, redaction, results, and timeouts.
- `packages/testing` — in-memory fakes, reusable port contracts, fixtures, and local upstream simulation.
- `tooling` — shared compiler, test, and generated lint rules.
- `apps` — future Cloudflare composition roots; no application package currently exists.
- `docs` — the v1 implementation plan and future architecture decisions.

## Invariants

- **Layer responsibilities**: domain rules belong in pure component packages; adapters translate external systems into contracts.
- **Single source of truth**: `contracts` owns shared entities, states, queue messages, ports, configuration schemas, and error codes. Other packages must not redeclare them.
- **Dependency direction**: component packages may depend on contracts, kernel, and domain packages but never on adapter packages, provider SDKs, or `cloudflare:*` modules.
- **External API access**: raw network access is confined to source, LLM, and notifier adapters. Other packages receive injected ports.
- **State ownership**: D1 is the intended correctness store; queues carry IDs and wake-up signals, not authoritative business state.
- **Authentication boundary**: the future API must validate Access identity inside the Worker and must not expose outbound provider credentials to the browser-facing deployment unit.
- **Integration boundaries**: adapters own provider payload validation and mapping; downstream code receives only contract types.
- **Determinism**: clocks, IDs, network clients, and failure injection enter through ports so contract and behavior tests remain reproducible.
- **Portability**: platform APIs, SQL dialect features, and provider-specific model IDs stay behind adapters or configuration.

## Cross-Cutting Concerns

Failures are represented by `AppError` and shared error codes. Structured logs must use the shared kernel redactor before reaching a telemetry sink. Queue consumers must be idempotent because delivery is at least once.

## Decisions

Significant architecture decisions belong in `docs/adr/` using the shared ADR structure. Consult [docs/architecture-v1.md](./docs/architecture-v1.md) for the full system plan; update or supersede that decision explicitly rather than silently violating it.

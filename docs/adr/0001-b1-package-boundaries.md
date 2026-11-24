# ADR-0001: Freeze B1 Package Boundaries

- **Status**: Accepted
- **Date**: 2026-11-20

> **Note (2026-11-24)**: since this decision, the shared test-support package and every package test suite were removed, and the KV and telemetry adapters in `runtime-cloudflare` were deleted. The package boundaries themselves still hold; [ARCHITECTURE.md](../../ARCHITECTURE.md) describes the current map.

B1 introduces the first implementations of the portable ports and deterministic policy on top of the shared contracts. Keep the cross-package domain vocabulary in `contracts`, policy in `core`, model-facing templates and schemas in `prompts`, and provider and platform behavior behind the existing ports. This keeps adapters interchangeable and lets each package prove its behavior locally without credentials or deployed infrastructure.

## Decision

- Freeze shared entities, normalized assessments, states, queue messages, errors, configuration, and ports before implementing consumers. A change to those definitions goes through the shared contract gate, not through package-local copies.
- Keep `core` pure: it takes contract values and explicit scalar inputs. Prompt-specific wire objects stay in `prompts` and cross into domain policy only as normalized contract values.
- Keep SQL, migrations, and row mapping in `storage`; provider protocol mapping in `sources` and `llm`; and Queue, R2, KV, secrets, and telemetry bindings in `runtime-cloudflare`. Platform and provider adapters do not import one another.
- Use declared package subpaths. No B1 package imports another B1 package; application roots will select and compose concrete adapters.
- Prove port behavior with shared contract suites where available and adapter-specific tests for mapping and failure behavior. Use synthetic exchanges, injected transports, and a local Worker emulator; never use real credentials or deployed services in B1 validation.

## Alternatives

- **Package-local copies of shared contracts** avoid the serial contract gate but make validation and compatibility drift independently.
- **Platform clients in use cases** reduce the number of boundaries but couple policy to runtime and provider dependencies, including credentials.
- **One infrastructure package** removes internal wiring but allows storage and provider behavior to depend on each other, undermining independent replacement and testing.

## Consequences

Shared contracts land before the independently owned package slices. Workspace references, lockfile importers, and generated lint configuration are reconciled once during integration. See the [B1 implementation contract](../archive/b1-implementation-contract.md) for ownership, provider limits, and acceptance checks.

Revisit this decision if an adapter needs a capability not expressible through a shared port, or if replacing a provider would require changing domain consumers rather than the adapter.

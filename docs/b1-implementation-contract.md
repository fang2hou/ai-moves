# B1 Implementation Contract

| Item          | Value                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| Status        | Integrated package implementations; no application composition or deployment            |
| Scope         | `core`, `storage`, `llm`, `prompts`, `sources`, `runtime-cloudflare`                    |
| Prerequisite  | C0: shared contract and testing delta                                                   |
| Runtime       | Node.js 24                                                                              |
| External work | No real service calls, credentials, Cloudflare resources, remote migrations, or deploys |

This contract defines the B1 package ownership and acceptance checks for the [v1 architecture plan](architecture-v1.md). [ADR-0001](adr/0001-b1-package-boundaries.md) records the durable boundary decision. B1 does not add application handlers or change deployment behavior.

## 1. Integration and Ownership

C0 must land before the five independent implementation slices. Each slice owns its package files, public exports, and local tests; S1.3 and S1.4 also own their named shared fixture directories. Only the integration owner reconciles root TypeScript references and lockfile importers and regenerates the lint configuration.

| Slice | Package or packages  | Runtime workspace dependencies                       | Fixture ownership                            |
| ----- | -------------------- | ---------------------------------------------------- | -------------------------------------------- |
| S1.1  | `core`               | `contracts`                                          | Package-local                                |
| S1.2  | `storage`            | `contracts`, `kernel`                                | Package-local                                |
| S1.3  | `llm`, `prompts`     | `llm`: `contracts`, `kernel`; `prompts`: `contracts` | `packages/testing/fixtures/openrouter/`      |
| S1.4  | `sources`            | `contracts`, `kernel`                                | `packages/testing/fixtures/{hn,github,web}/` |
| S1.5  | `runtime-cloudflare` | `contracts`, `kernel`                                | Package-local                                |

No B1 package imports another B1 package. Test-only helpers from `testing` do not enter runtime dependencies. All workspace consumers use explicit public subpaths; package-root barrels, cross-package relative imports, and `/src/` imports are not public APIs. Application roots, which are outside B1, will select concrete implementations.

## 2. C0 Shared Contracts

- `@ai-moves/contracts/analysis` owns strict, storage-neutral citations and normalized triage, HN deep, and changelog deep assessments. Citations have bounded locators and quotes. Triage requires a rejection reason only for rejects; deep assessments share confidence, rationale, summary, bounded lists, and citations, and distinguish HN importance (1–5) from changelog impact (0–3).
- Contract version `0.2.0` adds the analysis subpath and leaves queue message versions unchanged. Contract tests cover malformed inputs, strict fields, discriminants, and lossless JSON round trips.
- `LlmClient.generateStructured` accepts a caller-provided schema and returns validated output. Prompt-specific output schemas stay in `prompts`; translation is not a shared domain assessment.
- `JobBus.enqueueBatch` validates the entire batch before sending. An upstream send failure can still leave a partial success; consumers must be idempotent.
- `testing` supplies reusable repository and runtime port suites, scripted HN/GitHub/web/LLM fakes, synthetic fixture loading, and local Worker emulation. Catalog-pinned Miniflare and matching Worker types are test infrastructure, not runtime dependencies. B1 uses the existing storage, source, and runtime port signatures.

## 3. Package Acceptance

### S1.1 — Core

- Own deterministic HN scoring and gates, changelog priors, clustering, idempotency keys, item and delivery transition guards, and send/feed-only policy. Use the shared state definitions and pass time as an input.
- Expose behavior-specific paths under `/scoring`, `/state`, and `/policy`, plus `/clustering` and `/idempotency`. Do not read storage, inspect provider values, fetch, render prompts, or send queues.
- Test thresholds, legal and illegal transitions, duplicate-key stability, and suppression precedence for budgets, quiet hours, expiry, and tiers.

### S1.2 — Storage

- Own migrations, row codecs, in-memory repositories, and D1 repositories; expose `/memory`, `/d1`, and `/migrations`. Use conditional writes and idempotent inserts, preserve append-only audits, and write an alert and its deliveries atomically.
- D1 is the correctness store. Use expand-contract migrations; do not put scheduling, retry, queue publishing, or provider mapping into a repository.
- Run the shared suite against memory and the local D1 emulator. Test malformed rows as `ROW_INVALID`, competing claims, rollback, and migration from an empty schema.

### S1.3 — Prompts and LLM

- Expose versioned templates and strict schemas at `prompts/triage`, `/deep`, `/translate`, and `/versions`. Normalize triage and deep into C0 assessments; translation returns prose only. Bump the affected prompt version when its template or output contract changes.
- Expose `llm/openrouter` as an implementation of `LlmClient`. Inject HTTP transport and resolve the credential through `SecretProvider`. Keep request mapping, local schema validation, timeout, usage, and error classification in the adapter. Allow one repair for invalid model output and one configured fallback for eligible failures.
- Neither package persists analysis, consumes business budgets, or decides whether to deliver. Test prompt rendering, version identity, strict schema rejection, repair and fallback, timeout, and provider error classification against synthetic exchanges.

### S1.4 — Sources

- Expose `sources/hn`, `/github`, and `/web`; adapter-local protocol and security helpers are not entry points. Normalize provider data without scheduling, scoring, persistence, or model calls.
- Hacker News reads are unconditional: `HnClient` has no validator input and Firebase documents ETags for conditional writes, not 304 reads. Filter deleted and dead content. GitHub release, tag, and file reads use the caller's ETag and can return `not_modified`; compare is unconditional.
- For web fetches, require credential-free HTTPS, validate every address and redirect target, and use the injected pinned transport to prevent DNS fallback. Enforce content type, redirect, timeout, and byte limits.
- Test malformed data, GitHub ETag forwarding and 304s, deleted/dead HN content, blocked addresses and URLs, redirect target and DNS changes, content limits, and classified upstream failures. No test may fetch an unstubbed URL.

### S1.5 — Cloudflare Runtime

- Expose `/queue`, `/secrets`, `/telemetry`, `/blob-store`, `/cache`, and `/messages`. Implement portable Queue, secrets, telemetry, R2 blob, and KV cache ports and validate queue batches and scheduled events at the Worker boundary.
- Do not own D1, scheduling, pipeline stages, policy, or application composition. Never provision or deploy bindings.
- Run shared port suites plus tests for malformed messages, queue limits and delays, content hashing, TTL, missing bindings, and classified platform failures. Exercise Worker bindings only via synthetic bindings or a non-persistent loopback emulator that rejects outbound requests.

## 4. Integration Gates

1. Run `pnpm install --frozen-lockfile`. Reconcile only package importers and root references; use `pnpm lint:config` as the sole generator and verify it leaves the configured output unchanged.
2. Verify explicit package exports, no cross-B1 imports, and no imports into another package's source or barrels. The lint proof must reject a representative forbidden dependency.
3. Run each B1 package suite, then `mise run check`, `mise run test`, and `prek run --all-files`. Run the repository's secret scanner when configured.
4. Inspect the final diff and worktree. Confirm test isolation: injected transports and synthetic fixtures for providers, loopback with outbound denial for Worker emulation, and no deployment, credentials, or real service operations.

Stop integration if a shared contract or adapter cannot preserve another package's semantics, or if a shared delta would weaken idempotency or a security guarantee. Escalate with the conflicting commits and paths before choosing behavior. Real service calls, resource creation, deployment, and remote migrations are outside B1.

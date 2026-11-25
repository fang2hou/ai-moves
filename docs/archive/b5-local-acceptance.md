# B5 local acceptance

**Local scenarios and repository gates passed. Production is no-go.** The
tests exercised the pipeline with synthetic fixtures and local storage, not a
deployed Worker or live providers. The
[rollout checklist](./b5-rollout-checklist.md) remains open for production.

## Baseline and scope

- B4 baseline: `af689fca70c4e69e7d8dada15e163296f4d39b21`, the exact clean
  starting HEAD. The preflight's `e6119e3b9532570a52c7387d8bea6d48566e3d9f`
  is an ancestor. The intervening B4 change,
  `aebefdf483d5808f8a2b731d3d1245ea9a446c86`, added
  [public-link policy](../public-links.md) across ingestion, analysis, API and delivery.
- Tested HEAD: `95dc4c98876db94b73d113635b50d26b9fd76254`, tree
  `038accfa28c911477600ec0740933af7a1871b38`. Its parents are the exact B4
  baseline and the original checklist commit `971c90a95da274977071fe57468ce531de8c2ab5`.
  The clean tested tree differs from B4 only by that checklist. The subsequent
  report commit changes only this report and the checklist.
- Reviewed 2026-11-21 by the B5 acceptance worker; no production approver or
  operating owner was assigned here. Public B4 review links were not supplied
  and this checkout has no Git remote. Local review anchors are `0805616`
  (configuration), `9feb83f` (fault drills), `eab8997` (provider safety),
  `9675a9c` (observability) and `aebefdf` (links). Earlier review runs are not
  counted as B5 verification.
- Darwin arm64; mise 2026.11.10, Node 24.22.3, pnpm 12.21.0, prek 0.5.11,
  Vitest 4.1.12, Miniflare 4.20260730.0, Gitleaks 8.30.1 and Cocogitto 7.0.0.
  Miniflare used fresh loopback D1/R2 bindings; the production handler functions
  ran with injected clocks, IDs, queue publications and provider responses.
  The shared Vitest setup disables global network APIs; the pipeline emulator
  denies outbound and the scenario rejects pinned-web calls. Access assertions
  use an ephemeral local signing key and a synthetic audience.

## Gate results

Run from the repository root. See [Development](../../DEVELOPMENT.md) for the
normal workflow. No offline, lifecycle-script, or supply-chain policy bypass
was passed to pnpm. The install reused the local store and pnpm reported a
cached supply-chain policy verification; it did not perform fresh registry
verification in this run.

- `mise install` — exit 0; project pins already installed.
- `mise exec -- pnpm install --frozen-lockfile` — exit 0; 17 workspace
  projects, 84 packages reused, zero downloads.
- `mise exec -- pnpm --filter @ai-moves/ingestion test` — exit 0; 6 tests passed.
- `mise exec -- pnpm --filter @ai-moves/pipeline test test/pipeline.test.ts` —
  exit 0; 5 tests passed.
- `mise exec -- pnpm --filter @ai-moves/pipeline test test/delivery-replay.test.ts` —
  exit 0; 3 tests passed.
- `mise exec -- pnpm --filter @ai-moves/api test test/worker.test.ts` —
  exit 0; 10 tests passed, including config admission and legacy link projection.
- `mise run check` — exit 0; formatting, lint and TypeScript passed.
- `mise run test` — exit 0; static prerequisites passed, then 61 test files
  and 1,008 tests passed.
- `mise exec -- pnpm --filter @ai-moves/pipeline test test/b5-local-probe.test.ts` —
  exit 0; one temporary scenario passed. Reproduction below.
- `mise exec -- prek run --all-files` — exit 1 on the first report draft
  (`format-check`, Markdown table alignment); exit 0 after reformatting.
  The configured format, lint and TypeScript hooks passed; no scanner hook is
  configured.
- `gitleaks stdin --redact=100 --no-banner --no-color` — exit 0; no findings
  in the B5 checklist and report patch against B4, not a history scan.
- `cog verify 'docs(operations): record B5 local acceptance'` — exit 0;
  report subject accepted.

No separate soak was specified or run. No browser UI acceptance, cloud
operation, live provider request, credential handling, outbound send or
deployment was performed.

## Scenario-to-requirement evidence

The evidence below covers the local outcomes required by the
[v1 acceptance plan](./architecture-v1.md#11-observability-health-and-acceptance).
An ack alone does not prove a job ran, publication does not prove consumption,
and a `sent` row can be a dry run.

- **Schema round trips and deterministic states.** Contracts JSON round
  trips cover portable wire
  values; core tests cover legal transitions and
  stable keys. Storage contracts
  run against fresh D1 and in-memory backends.
- **Scripted polling, normalized bytes and authenticated reads.** The
  end-to-end pipeline test asserts
  the persisted release cursor, canonical item key and revision, and exact R2
  bytes through the stored revision key. An unsigned feed request returns
  401; signed feed, item and alert requests return the persisted item, one
  alert and the selected language document from the same D1.
  Ingestion tests cover
  conditional 304 and an unchanged body causing no new revision.
- **Queue recovery and compensation.** The pipeline test loses triage and
  delivery publications after state commits, recovers work on later ticks,
  and observes each scheduled branch progressing when the other fails.
  Replaying poll, triage, deep and delivery jobs repeats no model or notifier
  call. Ingestion tests
  cover partial acceptance and republished original buckets. The
  sweep test checks expired
  leases, lost fences, and no enqueue for expired sends marked `unknown`.
  Bounded selection is documented in the [runbook](../b4-operations-runbook.md#diagnose-stalled-work);
  a backlog larger than the query cap was not exercised end to end.
- **Per-message isolation.** The batch case
  retries one malformed message and acknowledges nine siblings. In the
  end-to-end case, malformed and misrouted messages retry next to triage
  work that persists state and incurs one debit. This is not platform redelivery.
- **Canonical analysis, translation and delivery.** The end-to-end case
  persists successful English deep analysis and Japanese translation, and a
  failed Simplified Chinese translation. Signed API reads show English and
  Japanese, preserve the command and evidence quote, withhold the failed
  language, and show exactly two sent rows. Scripted Slack and Discord requests
  contain their respective summaries. D1 replay
  retains the original alert, document and delivery, not the proposed
  replacement. Analysis tests
  cover translation fidelity failure and interrupted finalization.
- **Config and audit rejection.** API administration
  rejects an unsupported provider, timer overflow and bad domain with 400
  `INPUT_INVALID`, preserving the full active version and audit before
  accepting compatible version 2. Competing writes yield one winner and one
  audit event. A directly persisted incompatible or corrupt version fails
  pipeline load before ack, publication or provider contact. The B5 probe
  below demonstrates prior-config continuity on the same D1 without republishing.
- **No resend, retained debit and bounded retry.** D1 replay
  fences concurrent work, keeps the debit and leaves no retry time after
  `unknown`. Replay makes no second scripted send. The
  storage contract checks
  retention of interval and update reservations. A scripted retryable result
  waits for the jittered retry time and exhausts to `ATTEMPTS_EXHAUSTED`;
  destination disablement stops a separate due retry. Ingestion
  and analysis cover
  persisted backoff and bounded attempts.
- **Budget boundaries.** The pipeline persists `skipped_budget` and
  `BUDGET_EXHAUSTED` at repository and global triage limits with no model call.
  The repository debit can precede global denial; multi-scope debits are not
  atomic. Delivery source and destination quota cases persist `suppressed`
  without attempts, notifier calls or debits. Storage contracts cover receipt
  replay across midnight and stale-owner fencing. These are not provider
  request or spend limits.
- **Link safety.** Ingestion
  rejects userinfo and strips fragments while retaining internal query identity.
  Kernel,
  analysis and
  legacy API projection cover compatible
  HN links, query-bearing locator/document withholding, exact quotes and no
  model-invented target. The [delivery consumer](../../packages/delivery/src/execute.ts)
  applies the same rule before debit or notifier call; no dedicated
  legacy-document delivery rejection case was run.
- **Fixture replay and redaction.** Source and
  OpenRouter suites replay synthetic
  exchanges; fixture tests validate
  fixture shape. Kernel redaction and logging
  check nested attributes and errors, and pipeline scenarios assert classified
  errors. This does not establish deployed sinks or arbitrary exception safety.

### Reproduce the retained-config and dry-run probe

In a temporary `apps/pipeline/test/b5-local-probe.test.ts`, use the existing
`startPipeline`, `publish`, `seedSource`, `seedDestinations`, `syntheticAccess`
and `message` helpers in scenario.ts.
Publish version 1 with `delivery.force_dry_run: true`, seed the source and
destinations, and capture the audit snapshot. Call the actual API Worker with
the same D1, the synthetic `fixture-reader` subject in the admin allowlist, a
same-origin admin PUT and `expectedVersion: 1`; change only the translation
provider to an unsupported name. Assert 400 `INPUT_INVALID`, version 1 with the
original config and exact audit equality.

Release the scripted deep response, run one tick, and drain `q-poll`,
`q-triage`, `q-deep` and `q-deliver` through the Worker handlers in order.
Assert exactly two D1 rows, `en` and `ja`, both `sent`, `dry_run = 1`, no provider
receipt and `live_send_reserved = 0`. Assert only the scripted GitHub, triage,
deep and two translation calls, and no notify ledger for the source or either
destination. Run the probe command above and dispose the emulator in `finally`;
the temporary test was removed after the gate.

## Open production blockers

- **S4.2-01 — Delivery ambiguity.** Scripted transport failures and webhook
  5xx map to terminal `unknown`; replay does not resend. HTTP 429 remains
  retryable locally. Before live delivery, a delivery owner must establish
  from provider-specific primary evidence which retryable statuses mean
  unsent. Block automatic retry when that evidence is lacking.
- **S4.2-02 — Configuration admission.** Local audited rejection and prior-config
  continuity passed. Operators still need deployed admission evidence, a
  compatible rollback, and a plan to drain or isolate versioned pending work.
- **S4.2-03 — Model-output trust.** Analysis finalization supplies
  `suspectedInjection: false`. Valid schemas and citations are not semantic
  safety controls. Enforce feed-only or human review before outbound delivery;
  routing must remain program-owned.
- **S4.2-04 — Response limits.** Local notifier and OpenRouter tests check
  streamed byte caps and cancellation. Overflow yields unknown Discord
  confirmation or an invalid OpenRouter response, distinct from OpenRouter
  timeout. Deployed transport cancellation, limits and semantics are unverified.
- **S4.2-05 — Public links.** Local policy passed the cases above. Verify
  deployed publication paths and rollback compatibility; stored input, URL
  paths, arbitrary text and content after navigation are not generally
  sanitized. Older binaries expect a string where new deep snapshots may
  hold a null source locator.
- **S4.2-06 — Redaction.** Pipeline boundary errors and dimensions are
  classified. Require allowlisted fields across deployed sinks, egress and
  platform tracing, plus review of persisted errors. Pattern redaction does
  not make arbitrary exceptions safe. Exclude full webhook URLs, credentials,
  prompts, headers and payloads.
- **S4.2-07 — Secret scope and egress.** Provider and destination lookups
  share the Worker binding namespace. Require independent scopes,
  operator-approved references and webhook path/query rules, and separate
  egress restrictions. No exposure was observed.
- **S4.2-08 — Resolver deadlines and bounds.** A caller's late-result guard
  is not resolver cancellation. Require independent deadlines, bounded
  answers that reject overflow, and cancellation propagation where supported.
  Verify that deployed pinned fetch preserves original-host TLS/HTTP, connects
  to the validated IP without a second lookup or hostname fallback, and
  rechecks redirects. Validate resolver capacity independently.

Historical scanner tuples were already reconciled as synthetic; this scoped
scan does not reopen them. The automatic secret scanner remains an open
[Git-governance item](../../DEVELOPMENT.md#git-governance).

Before rollout, assign owners and approve the account, destinations, model IDs,
budgets and license; confirm limits, pricing, quotas and status semantics from
primary sources. Verify deployed Access issuer, audience, JWKS rotation and
revocation, admin allowlist, Worker-first static routing, disabled public
bypass, least-privilege D1/R2 and separation of browser-facing bindings from
provider credentials. Neither `/healthz` nor the console metrics prove
pipeline dependency readiness or durable backlog.

Require finite retries and owned DLQs for every actual queue, with alerts and
reviewed triage/replay; verify production redelivery, D1 isolation and platform
limits independently. Establish independent spend/rate limits, alert thresholds
and reversible stop controls. Maintain a compatible rollback plan before
changing versions with pending work. If a delivery is `unknown`, preserve its
state, reservation and debit; do not reset, refund or resend it. Stopping new
work does not cancel an in-flight operation. None of these checks authorizes
production changes; separate human approval at the operation boundary is required.

## Pinned engineering guidance

Verified and read the raw English
[guidelines at `3f6fd7c`](https://github.com/fang2hou/ai-coding-guidelines/tree/3f6fd7cb8db007f216b79a90763242b46c265cb7):
Baseline, Write tests, Security-sensitive change, Architecture change and
Commit/open a PR, plus the relevant toolchain, documentation and language
sections. Scope is this acceptance change, not a repository compliance audit.

- **Core principles and agent protocol:** scope, validation speed, tool choice,
  causes, operating protocol, memory and hard rules applied through the
  verified baseline, narrow local gates and docs-only diff. No bypass or soak.
- **Testing and coding standards:** behavior, conventions, simplicity, names,
  comments, modularity, files and performance applied in the temporary probe
  via existing fixtures and persisted outcomes. No new dependencies;
  frontend E2E, unit and responsiveness guidance not applicable to this change.
- **Security:** sensitive data, storage and scanning applied through
  synthetic-only runtime evidence and a redacted patch scan. Hook remains open.
- **Architecture governance:** invariants and ADRs are preserved; no runtime,
  storage or dependency-boundary changes.
- **Documentation and language:** existing AGENTS, README, Development,
  Contributing and Architecture guidance remains in place. English acceptance
  evidence is linked from the checklist; UI and code languages did not change.
- **mise and TypeScript:** existing pins, tools, task entry points and strict
  checks used; no lifecycle, tooling, CI, compiler or MCP configuration changes.
- **Quality gates, Git and change discipline:** configured checks, scoped
  review and Conventional Commit verified. Automatic scanning, Cocogitto
  wiring and related Git governance remain open. Green tests are not
  production readiness evidence.

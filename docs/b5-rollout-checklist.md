# B5 rollout checklist

This checklist separates local acceptance from production readiness. It does not
record a passed B4 or B5 gate, authorize deployment, or establish that a
production control exists. Use the final B4 integration as the acceptance
baseline and review changes since earlier preflight work.

Sources: [architecture and invariants](../ARCHITECTURE.md),
[architecture plan](./architecture-v1.md),
[durable work and delivery decisions](./adr/0002-b2-durable-work.md),
[development and validation](../DEVELOPMENT.md), and the
[pipeline operations runbook](./b4-operations-runbook.md).

## Decision and evidence

- [ ] Record the final B4 commit, relevant review links, tested commit,
      environment, owners, dates, and evidence locations. Record each gate as
      passed, failed, or not assessed; identify its reviewer and open risks.
- [ ] Use **no-go** when a required gate lacks evidence, has failed, or has no
      accountable owner. A local pass is not production evidence. An exception
      requires an explicit owner decision and must not bypass a mandatory
      security or authorization gate.
- [ ] Before each resource creation, permission or credential change, migration,
      deployment, or enablement of real outbound messages, obtain explicit
      human authorization for the exact target, scope, and timing. This
      checklist is not that authorization.
- [ ] Confirm the production account, destinations, model identifiers, budgets,
      and license with their owners. Recheck platform limits, provider pricing,
      webhook semantics, and quotas against current primary documentation.

## Local acceptance evidence

Reserve execution for the final B4 integration. Use synthetic fixtures, local
bindings, and scripted transports without real provider credentials or outbound
requests. Record exact commands, exit codes, test references, failures, and
uncovered cases; follow the local commands and validation workflow in
[Development](../DEVELOPMENT.md#local-pipeline) and the
[runbook](./b4-operations-runbook.md#reproduce-locally).

- [ ] Map evidence to schema round trips, deterministic transitions, retries,
      idempotency, fixture replay, budget boundaries, redaction, and end-to-end
      compensation, as required by the
      [acceptance plan](./architecture-v1.md#11-observability-health-and-acceptance).
- [ ] Cover poll and normalization, authenticated API reads, per-message
      isolation, lost publication and recovery, fencing and replay, failed
      translation, simulated delivery, and unresolved delivery outcomes.
- [ ] Verify incompatible configuration publication is rejected without
      changing the active version or its audit history; verify the previous
      configuration remains usable.
- [ ] Record full repository validation separately from targeted scenarios.
      The acceptance plan does not itself specify an independent long-running
      soak; do not describe a scenario rerun as one.

Local emulation does not prove production queue redelivery, D1 isolation,
concurrency, service limits, or egress enforcement. Console signals are
best-effort observations: an acknowledgement is not proof of a product outcome,
publication is not consumption, and a `sent` metric can include simulated
delivery. The runbook describes these limitations in detail.

## Production go/no-go gates

- [ ] **Egress:** independently verify that `PINNED_WEB` connects to the
      validated address without another DNS lookup, preserves the original host
      for TLS and HTTP, revalidates redirects, and has no ordinary hostname-fetch
      fallback. Verify private and reserved address denial, resolver deadlines,
      bounded answers with rejection on overflow, and cancellation where
      supported. Verify `PROVIDER_HTTP` destination restrictions, redirect and
      cancellation behavior, and credential-safe logging.
- [ ] **Access and isolation:** verify the deployed Access application, issuer,
      audience, JWKS rotation and revocation, admin allowlist, Worker-first
      static routing, and disabled public `workers.dev` bypass. Review least
      privilege for D1 and R2, platform concurrency and atomicity, and confirm
      the browser-facing Worker has no outbound provider credentials.
- [ ] **Model-output trust:** demonstrate an actually enforced feed-only
      restriction or a human-review control before outbound delivery. Treat
      source content and generated prose as untrusted; keep routing
      program-owned. A valid schema or citation does not establish semantic
      safety, and a keyword filter is not a substitute for review.
- [ ] **Queues and delivery:** establish finite retries and a DLQ for each
      queue, with named owners, access, alerts, triage, and a reviewed replay
      policy. Verify platform redelivery independently. Obtain provider-specific
      evidence for outcomes treated as retryable, including rate limits; if
      delivery cannot be established as unsent, do not automatically retry it.
- [ ] **Configuration and pending work:** inventory pending work and version
      dependencies; approve a drain or tested migration and rollback plan before
      changing prompts, models, schemas, budgets, or policies. Verify
      compatibility with existing work and the prior-version window rather than
      assuming an active configuration change isolates pending analysis.
- [ ] **Spend and monitoring:** establish provider-side spend and rate limits,
      alerts, and a stop mechanism independent of application budgets.
      Logical model-call budgets do not count every repair or fallback request.
      Set owner-approved abort criteria before rollout and provide monitoring
      for persisted work, queue and DLQ depth, delivery outcomes, and spend.
- [ ] **Secrets and published links:** review provider and destination secret
      scopes, approved destination references and webhook paths, and independent
      egress restrictions. Define and enforce a public URL policy at ingestion
      and publication, including userinfo, fragments, and permitted query
      fields. Do not log raw URLs, credentials, prompts, message bodies, or
      provider responses.
- [ ] **Secret scanning:** resolve the separately deferred secret-scanning hook
      through the dedicated Git-governance work described in
      [Development](../DEVELOPMENT.md#deferred-git-governance); do not use a
      blanket suppression for synthetic fixtures.

## Rollback and unresolved outcomes

- [ ] Before rollout, name the decision maker and operators, record approved
      stop controls, and retain a known-good compatible release and
      configuration. Define how to assess pending work and schema compatibility
      before restoring them.
- [ ] On an abort, stop new ingestion and sends through an approved reversible
      control. Preserve durable state, leases, receipts, and evidence. Stopping
      new work does not cancel an in-flight request.
- [ ] Do not resend an `unknown` delivery, reset it to `pending`, release its
      reservation, or refund its debit. The delivery owner must reconcile using
      authorized read-only evidence; any later action requires separate
      approval and evidence that it will not duplicate a send.
- [ ] If pending work, schema, or prompt versions are incompatible with the
      prior release or configuration, halt and escalate rather than forcing
      replay or editing durable rows. Follow the
      [runbook's recovery guidance](./b4-operations-runbook.md#treat-unknown-delivery-as-unresolved).

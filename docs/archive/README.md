# Archive

These documents record how AI Moves was planned and accepted up to 2026-11-23. They are kept for history only. They describe a product that no longer exists: a desk behind Cloudflare Access, a feed-only rollout without Discord sends, a five-minute schedule, a pinned web egress and a test suite with a shared test-support package. Nothing here is a current instruction, and the documents are not updated.

| Document                                                         | What it was                                                                                        |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [architecture-v1.md](./architecture-v1.md)                       | The v1 architecture plan. The configuration defaults still cite its section numbers.               |
| [b1-implementation-contract.md](./b1-implementation-contract.md) | Ownership and acceptance checks for the first package implementations.                             |
| [b2-shared-handoff.md](./b2-shared-handoff.md)                   | How the durable-work ports were to be sequenced when the applications were composed.               |
| [b4-operations-runbook.md](./b4-operations-runbook.md)           | A local diagnosis guide and production gates, written for the feed-only rollout and pinned egress. |
| [b5-local-acceptance.md](./b5-local-acceptance.md)               | The acceptance report of the test suite that was removed.                                          |
| [b5-rollout-checklist.md](./b5-rollout-checklist.md)             | Production go/no-go gates written before the first deployment.                                     |

Read [ARCHITECTURE.md](../../ARCHITECTURE.md), [DEVELOPMENT.md](../../DEVELOPMENT.md) and the decisions in [docs/adr](../adr/) instead. [ADR-0004](../adr/0004-public-desk-access-for-administration.md) to [ADR-0008](../adr/0008-static-checks-instead-of-a-test-suite.md) record what changed.

Relative links were adjusted when the documents moved. Links to test files name files that no longer exist, and links into [DEVELOPMENT.md](../../DEVELOPMENT.md) keep anchors from the earlier version of that guide.

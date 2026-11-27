# Archive

Planning and acceptance documents from before the product redesign. They record how the system was first specified and checked; they do not describe `main`. For the current system, read [ARCHITECTURE.md](../../ARCHITECTURE.md).

| Document                                                         | What it was                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [architecture-v1.md](./architecture-v1.md)                       | The original v1 system plan, including the numbered sections code comments cite |
| [b1-implementation-contract.md](./b1-implementation-contract.md) | Ownership, provider limits, and acceptance checks for the first package slices  |
| [b2-shared-handoff.md](./b2-shared-handoff.md)                   | Port handoff and consumer sequencing for durable work and audited writes        |
| [b5-local-acceptance.md](./b5-local-acceptance.md)               | The local acceptance record against the removed test suite                      |
| [b5-rollout-checklist.md](./b5-rollout-checklist.md)             | The pre-deployment gate checklist for the first rollout                         |

Notes for readers:

- Code comments that cite "architecture X.Y" or `docs/architecture-v1.md` refer to `architecture-v1.md` here.
- The files were moved without edits except for relative link paths. Links to test files and `packages/testing`, which no longer exist, were turned into plain text.
- Several things described here are gone from `main`: the test suite, `packages/testing`, and the KV and telemetry adapters were removed; the Access-gated feed is now public; and the always-on feed-only rollout is gone: delivery is always live (the `delivery.feed_only` and `delivery.force_dry_run` switches that replaced it were removed).

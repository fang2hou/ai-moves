# D1 storage adapter

Implements the storage ports from `@ai-moves/contracts/ports/storage` on Cloudflare D1. This package is the Phase 1 half of the storage seam: a Phase 2 adapter implements the same ports on an AWS store (see [ARCHITECTURE.md](../../ARCHITECTURE.md#two-phase-cloud-portability)).

| Import                            | Provides                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@ai-moves/storage-d1/d1`         | `createD1Storage`: the D1 repositories, with row codecs that validate every stored row on read          |
| `@ai-moves/storage-d1/migrations` | `STORAGE_MIGRATIONS` and `applyStorageMigrations`: the ordered schema and its applied-migrations ledger |

- It depends on `contracts`, `kernel`, and the shared rules in [`@ai-moves/storage/rules`](../storage/README.md), and it is the only package besides the apps and `runtime-cloudflare` with the `platform` capability.
- The domain calls a blob reference `blob_key`; the SQLite columns `item_revisions.r2_key` and `analyses.r2_key` keep their Phase 1 name. `d1.ts` writes `blob_key` into `r2_key`, and `codecs.ts` reads `r2_key` back as `blob_key`, so the rename needed no migration. Nothing outside this package names `r2_key`.
- Schema changes append to `STORAGE_MIGRATIONS`; `tools/local/schema-sql.ts` renders the unapplied ones for the deploy workflow.

# D1 storage adapter

Implements the storage ports from `@ai-news-tracker/contracts/ports/storage` on Cloudflare D1. This package is the Phase 1 half of the storage seam; [`@ai-news-tracker/storage-dynamodb`](../storage-dynamodb/README.md) implements the same ports on Amazon DynamoDB (see [docs/portability.md](../../docs/portability.md)).

| Import                                   | Provides                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@ai-news-tracker/storage-d1/d1`         | `createD1Storage`: the D1 repositories, with row codecs that validate every stored row on read          |
| `@ai-news-tracker/storage-d1/migrations` | `STORAGE_MIGRATIONS` and `applyStorageMigrations`: the ordered schema and its applied-migrations ledger |

- It depends on `contracts`, `kernel`, and the shared rules in [`@ai-news-tracker/storage/rules`](../storage/README.md), and it is the only package besides the apps and `runtime-cloudflare` with the `platform` capability.
- The domain calls a blob reference `blob_key`; the SQLite columns `item_revisions.r2_key` and `analyses.r2_key` keep their Phase 1 name. `d1.ts` writes `blob_key` into `r2_key`, and `codecs.ts` reads `r2_key` back as `blob_key`, so the rename needed no migration. Nothing outside this package names `r2_key`.
- Schema changes append to the ordered `STORAGE_MIGRATIONS` list; a deploy applies only the migrations its database has not recorded, the ones `tools/local/schema-sql.ts` renders for it.
- Historical configuration versions can contain retired quota keys. The configuration schema discards those keys at read time, and the original rows stay intact. Historical budget states and reasons remain readable.
- Existing schemas retain `destinations.daily_budget`, `budget_ledger`, and `budget_charges` during rollout. Destination inserts supply zero for the required legacy column, and the application no longer uses the ledger or charge tables.

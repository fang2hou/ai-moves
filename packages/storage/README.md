# Storage

Portable storage code with no platform dependency. The `tooling/src/boundaries.ts` entry grants this package no `platform` capability, so it cannot import `@cloudflare/*` or `cloudflare:*` modules.

| Import                            | Provides                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@ai-news-tracker/storage/memory` | `createMemoryStorage`: every storage port from `@ai-news-tracker/contracts/ports/storage` held in memory |
| `@ai-news-tracker/storage/rules`  | `validateLease`, `validateAlertDocuments`, and `sendIntervalCutoff`, shared by every storage adapter     |

The in-memory adapter is the reference for a second storage adapter. Blob references use the domain name `blob_key`. The platform adapters are [`@ai-news-tracker/storage-d1`](../storage-d1/README.md) and [`@ai-news-tracker/storage-dynamodb`](../storage-dynamodb/README.md).

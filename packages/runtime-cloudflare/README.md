# Cloudflare runtime adapters

Implements the portable runtime and storage ports from `@ai-moves/contracts` on Cloudflare bindings, and decodes Worker-shaped events before application code sees them. This package is the Phase 1 half of the runtime seam: a Phase 2 `runtime-aws` package implements the same ports on S3, SQS, Secrets Manager, and EventBridge (see [ARCHITECTURE.md](../../ARCHITECTURE.md#two-phase-cloud-portability)).

| Import                                    | Provides                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@ai-moves/runtime-cloudflare/blob-store` | `createCloudflareBlobStore`: a content-addressed `BlobStore` on R2, keyed by the SHA-256 of the bytes       |
| `@ai-moves/runtime-cloudflare/queue`      | `createCloudflareJobBus`: a `JobBus` on Cloudflare Queues that validates every job before sending any       |
| `@ai-moves/runtime-cloudflare/secrets`    | `createCloudflareSecretProvider`: a `SecretProvider` over Worker secret bindings                            |
| `@ai-moves/runtime-cloudflare/messages`   | `decodeQueueBatch` and `decodeScheduledEvent`: Worker queue batches and cron controllers to contract values |

It depends only on `contracts` and `kernel`, describes bindings structurally instead of importing `@cloudflare/workers-types`, and excludes D1 (see [`@ai-moves/storage-d1`](../storage-d1/README.md)), use cases, composition, resource creation, and deployment.

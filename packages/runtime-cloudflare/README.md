# Cloudflare runtime adapters

Implements the portable runtime and storage ports from `@ai-news-tracker/contracts` on Cloudflare bindings, and decodes Worker-shaped events before application code sees them. This package is the Phase 1 half of the runtime seam; [`@ai-news-tracker/runtime-aws`](../runtime-aws/README.md) implements the same ports on S3, SQS, SSM Parameter Store, and EventBridge (see [docs/portability.md](../../docs/portability.md)).

| Import                                           | Provides                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `@ai-news-tracker/runtime-cloudflare/blob-store` | `createCloudflareBlobStore`: a content-addressed `BlobStore` on R2, keyed by the SHA-256 of the bytes       |
| `@ai-news-tracker/runtime-cloudflare/queue`      | `createCloudflareJobBus`: a `JobBus` on Cloudflare Queues that validates every job before sending any       |
| `@ai-news-tracker/runtime-cloudflare/secrets`    | `createCloudflareSecretProvider`: a `SecretProvider` over Worker secret bindings                            |
| `@ai-news-tracker/runtime-cloudflare/messages`   | `decodeQueueBatch` and `decodeScheduledEvent`: Worker queue batches and cron controllers to contract values |

It depends only on `contracts` and `kernel`, describes bindings structurally instead of importing `@cloudflare/workers-types`, and excludes D1 (see [`@ai-news-tracker/storage-d1`](../storage-d1/README.md)), use cases, composition, resource creation, and deployment.

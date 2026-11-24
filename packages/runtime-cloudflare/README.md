# Cloudflare runtime adapters

This package adapts Cloudflare Queues, Worker secrets, R2, and KV to the portable ports in `@ai-moves/contracts`.

It also validates Worker-shaped queue batches and scheduled events before application code sees them. It intentionally excludes D1, use cases, application composition, resource creation, and deployment.

Public imports are explicit:

- `@ai-moves/runtime-cloudflare/queue`: `createCloudflareJobBus` validates each job and turns an `enqueue` or `enqueueBatch` into a `send` or `sendBatch` on the binding of the job's queue.
- `@ai-moves/runtime-cloudflare/secrets`: `createCloudflareSecretProvider` reads a secret from the bindings object it is given and fails with `SECRET_MISSING` for any other name.
- `@ai-moves/runtime-cloudflare/blob-store`: `createCloudflareBlobStore` is a content-addressed store over an R2 bucket.
- `@ai-moves/runtime-cloudflare/messages`: `decodeQueueBatch` and `decodeScheduledEvent` check a batch and a scheduled event against the Worker shape.
- `@ai-moves/runtime-cloudflare/telemetry` and `@ai-moves/runtime-cloudflare/cache`: a telemetry writer over an injected function and a cache over a KV namespace. Neither Worker uses them; the pipeline logs through `@ai-moves/kernel/telemetry/console`.

The pipeline Worker (`apps/pipeline`) is the only consumer. It uses `queue`, `secrets`, `blob-store`, and `messages` (`apps/pipeline/src/worker.ts`, `apps/pipeline/src/bindings.ts`), and it exposes exactly three secrets to the pipeline: `GITHUB_TOKEN`, `OPENROUTER_API_KEY`, and `DISCORD_WEBHOOK_URL` (`apps/pipeline/src/bindings.ts`). The desk Worker binds none of them.

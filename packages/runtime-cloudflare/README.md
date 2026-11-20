# Cloudflare runtime adapters

This package adapts Cloudflare Queues, Worker secrets, structured logging, R2, and KV to the portable ports in `@ai-moves/contracts`.

It also validates Worker-shaped queue batches and scheduled events before application code sees them. It intentionally excludes D1, use cases, application composition, resource creation, and deployment. Tests use synthetic bindings and non-persistent Miniflare instances only.

Public imports are explicit:

- `@ai-moves/runtime-cloudflare/queue`
- `@ai-moves/runtime-cloudflare/secrets`
- `@ai-moves/runtime-cloudflare/telemetry`
- `@ai-moves/runtime-cloudflare/blob-store`
- `@ai-moves/runtime-cloudflare/cache`
- `@ai-moves/runtime-cloudflare/messages`

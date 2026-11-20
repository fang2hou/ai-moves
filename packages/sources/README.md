# Source adapters

- `@ai-moves/sources/hn`: `createHnClient` reads ranked IDs, stories, and bounded comment trees from the official Hacker News Firebase API. It omits deleted and dead stories and comments. Reads are unconditional: the shared HN port has no validators, and Firebase documents ETags for conditional writes, not HTTP 304 reads.
- `@ai-moves/sources/github`: `createGitHubClient` uses the caller’s ETag for releases, tags, and repository files, returning a new ETag on a modified result. Each list fetches one page of ten. Compare is an on-demand, unconditional request. Authentication is optional; redirects carrying credentials stay on the GitHub API origin.
- `@ai-moves/sources/web`: `createWebFetcher` accepts credential-free HTTPS URLs on port 443 and rejects IP literals. It validates every DNS answer on every hop, then passes one validated address to `fetchPinned`. The runtime must connect directly to that address without DNS fallback or proxying, preserve the original TLS/HTTP host, and honor manual redirects. A general-purpose `fetch` is not a pinned transport.

Web fetches use the shared content-type, timeout, and redirect settings. Text is decoded as UTF-8; HTML is converted to text without rendering it or loading assets. Over-limit web responses return the retained prefix with `truncated: true`; `content_hash` is SHA-256 of the returned text. Provider JSON exceeding the adapter limits is rejected.

Provider transports are injected. The tests replay synthetic exchanges from `packages/testing/fixtures` and do not call real services.

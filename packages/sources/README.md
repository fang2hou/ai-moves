# Source adapters

Protocol adapters behind the source ports in `@ai-news-tracker/contracts/ports/sources`. Each takes an injected transport, so the composition root decides how requests leave the runtime.

- `@ai-news-tracker/sources/hn`: `createHnClient` reads top story IDs, stories, and bounded comment trees from the official Hacker News Firebase API, omitting deleted and dead entries. Reads are unconditional; the HN port has no validators.
- `@ai-news-tracker/sources/github`: `createGitHubClient` lists releases and tags (one page of 10 each) and reads repository files, sending the caller's ETag and returning the new one on a modified result. Authentication is optional; redirects are followed manually, capped, and kept on the GitHub API origin.
- `@ai-news-tracker/sources/web`: `createWebFetcher` accepts credential-free HTTPS URLs on port 443 and rejects IP literals and denied domains. It resolves the hostname through the injected `resolve`, rejects more than 32 answers, validates every answer as a public address, and passes one checked address to the injected `fetchPinned`, hop by hop under one overall deadline.

Web fetches share the configured content types, size limit, timeout, and redirect limit. The adapter streams up to `web_fetch.max_bytes` (1 MiB by default), then extracts text from the bounded prefix for HTML responses. Text is decoded as UTF-8; HTML is converted to text without rendering or loading assets. An over-limit response returns the retained prefix with `truncated: true`, and `content_hash` is the SHA-256 of the returned text. Provider JSON above the adapter limits is rejected.

**Pinning depends on the transport.** The local runner (`tools/local/run.ts`) connects to the checked address. A deployed Worker cannot open a socket to a chosen address, so `apps/pipeline/src/egress.ts` resolves through DNS-over-HTTPS and then fetches by hostname, relying on the platform to refuse private addresses.

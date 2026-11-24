# Source adapters

- `@ai-moves/sources/hn`: `createHnClient` reads ranked IDs, stories, and bounded comment trees from the official Hacker News Firebase API. It omits deleted and dead stories and comments. Reads are unconditional: the shared HN port has no validators, and Firebase documents ETags for conditional writes, not HTTP 304 reads.
- `@ai-moves/sources/github`: `createGitHubClient` uses the caller's ETag for releases, tags, and repository files, returning a new ETag on a modified result. Each list fetches one page of ten. Compare is an on-demand, unconditional request. Authentication is optional; redirects carrying credentials stay on the GitHub API origin.
- `@ai-moves/sources/web`: `createWebFetcher` accepts credential-free HTTPS URLs on port 443 and rejects IP literals and denied domains. It rejects more than 32 DNS answers per hop without truncating, validates every accepted answer as a public address, and then hands the request and one validated address to `fetchPinned`. Redirects are followed by hand, up to the configured limit, and every hop is resolved and checked again.

Web fetches use the shared content-type, timeout, and redirect settings. Text is decoded as UTF-8; HTML is converted to text without rendering it or loading assets. Over-limit web responses return the retained prefix with `truncated: true`; `content_hash` is SHA-256 of the returned text. Provider JSON exceeding the adapter limits is rejected.

Injected resolvers receive the overall deadline signal. Late results never reach the transport. This bounds answer validation after resolution, not allocation or work in the resolver itself.

## Pinned transport

`fetchPinned` is injected, so what it does is the runner's decision. The fetcher asks for a connection to the validated address, with the request host kept for TLS and HTTP.

Only the local demo does that. `tools/local/run.ts` connects with Node's `https` module and pins the socket to the address. A deployed Worker cannot open a socket to a chosen address, so `apps/pipeline/src/egress.ts` resolves the hostname over DNS-over-HTTPS, returning at most 32 addresses, and then calls the platform's `fetch` by hostname. There the address check is a check and nothing more: the request is not pinned, and the comment in that file relies on the Workers runtime refusing to route to a private address. Do not describe the deployed egress as pinned.

Provider transports are injected. A change is verified by running the adapter with a fake transport, never against a real service.

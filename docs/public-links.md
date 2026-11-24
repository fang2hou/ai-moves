# Public source and citation links

The rules live in `packages/kernel/src/public-links.ts`. Ingestion, analysis, the API, and delivery all call them; none keeps a private copy.

## Stored source URLs

Ingestion (`observedSourceUrl`) stores a trimmed HTTP(S) URL without userinfo or control characters, with its fragment removed. The query is kept because removing it can change the resource. A URL that fails the rule is stored as `null`.

## Reader-facing links

`publicLink` applies the same rule to every link a reader can follow: HTTP(S) only, no userinfo, no control characters, the fragment removed, and at most 2048 characters. Query strings are allowed: tracking-free source URLs are the exception on the open web, and rejecting them suppressed whole documents. A link that fails is withheld, never rewritten to a different page.

- The feed and item API return `url: null` for an unpublishable item link (`apps/api/src/views.ts`).
- An alert document needs a publishable source link and detail link; an unpublishable discussion link is omitted (`publicAlertLinks`).
- Every link mentioned in a document's source label, titles, summary, key points, quotes, or community view must itself be publishable and carry no fragment. Otherwise the whole document is withheld rather than edited, because a verified quote is never rewritten (`publicAlertDocument`).
- The API and delivery apply these checks when they read a stored document; stored rows are not rewritten.

## Evidence locators

Deep analysis passes a fetched text to the model only when its locator is already a publishable link unchanged, so evidence from a URL with a fragment or userinfo is dropped. Analysis with no publishable evidence fails with `CONTENT_UNSUPPORTED`.

## Scope

This policy governs URLs, not every possible secret in free-form source content, URL paths, or upstream responses. It does not change outbound fetch restrictions (see `packages/sources/src/web.ts`) or guarantee what a reader finds after following a link.

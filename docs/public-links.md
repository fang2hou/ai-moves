# Public source and citation links

Ingestion stores a credential-free HTTP(S) source URL without its fragment. Its
query remains available for fetching and internal identity because removing it
can change the resource. The stored URL is not a reader-facing link.

Reader-facing links and model evidence locators use a stricter rule: no userinfo,
no fragment, and no query except a single positive integer `id` on
`https://news.ycombinator.com/item`. A link with any other query is withheld, not
rewritten to a different page. Evidence from a fetched response is cited by its
final locator only when that locator can be published; citations still require
an exact locator match and a verbatim quote.

The feed and item API return `url: null` for an unpublishable link. An alert
without a publishable source or detail URL has no document to display or deliver.
An unpublishable discussion link is omitted. API reads and delivery apply the
same checks to existing documents without rewriting stored rows. Documents
containing recognizable unsafe HTTP(S) links in prose or quotes are withheld,
rather than editing a verified quote.

This policy governs URLs, not every possible secret in free-form source content,
URL paths, or upstream responses. It does not change outbound fetch restrictions
or guarantee what a reader encounters after following a link.

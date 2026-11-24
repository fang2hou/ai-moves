# Public source and citation links

The rules live in `packages/kernel/src/public-links.ts`. They decide which URLs the product stores, which it shows a reader, and when prose or a whole document is withheld. This page describes that file; the code decides.

## What a link has to be

`publicLink(input)` trims the text and returns it without its fragment, or `null`. It returns `null` when:

- the scheme is not `http` or `https`, or the text does not parse as a URL;
- an `@` appears before the first slash, question mark or hash, which is a userinfo;
- the text contains a control character;
- the text before the fragment is longer than 2048 characters.

A query string is allowed on any host. Tracking-free source URLs are the exception on the open web, and rejecting them suppressed whole documents. `http` passes here; fetching a page has a stricter rule, listed at the end.

## Where each rule applies

| Function              | Rule                                                                                                                | Called from                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `observedSourceUrl`   | The source URL stored with an observed item: the rule above, fragment removed, query kept. `null` stays `null`.     | `packages/ingestion/src/observations.ts`                                                                                                    |
| `publicLink`          | One link on its way to a reader or a model: the `url` of a feed item, the links of a card, an evidence locator.     | `apps/api/src/views.ts`, `packages/delivery/src/render/discord.ts`, `packages/delivery/src/execute.ts`, `packages/analysis/src/evidence.ts` |
| `publicAlertLinks`    | The three links of a document. `source` and `detail` have to pass or the set is `null`; `discussion` may be absent. | `packages/analysis/src/finalization.ts`                                                                                                     |
| `hasPublicLinkText`   | A prose field. Every `http://` or `https://` mention has to be a public link without a fragment.                    | `publicAlertDocument`, `packages/analysis/src/finalization.ts`                                                                              |
| `publicAlertDocument` | A whole document: its links and its prose. Returns the document with trimmed, fragment-free links, or `null`.       | `apps/api/src/views.ts`, `packages/delivery/src/execute.ts`                                                                                 |

## Evidence and citations

- A piece of evidence is kept only when its locator is a public link. The locator is stored in its public form (`add` in `packages/analysis/src/evidence.ts`).
- A citation is verified when its locator is one of the evidence locators and its quote appears character for character in that evidence (`verifyCitations` in `packages/analysis/src/evidence.ts`).
- A quote that is not verified is dropped from the page. One such quote is enough to stop a card: the alert is recorded as `feed_only` with the reason `citation_check_failed` (`packages/analysis/src/finalization.ts`).
- A verified quote is kept only when the quote and the item title pass `hasPublicLinkText`.
- The model may mention a link in its prose only when the program supplied it: the source link, the discussion link or an evidence locator. A reading that mentions any other link gets no document (`hasKnownLinks` in `packages/analysis/src/finalization.ts`).

## Prose

`hasPublicLinkText` looks for `http://` and `https://` mentions. A mention followed by sentence punctuation still passes, because the characters `])}"'.,!;` at its end are removed first. A bare host name such as `www.example.com` is not a mention.

`publicAlertDocument` applies this to `source_label`, `title.original`, `title.translated`, `summary`, the `text`, `implication` and `evidence_quote` of every point, and the `summary`, `supporting` and `opposing` of the community view. If one of them fails, the document is withheld. It is not edited to remove the link.

## What a reader sees

- The feed and item API return `url: null` for an item whose source URL is not a public link (`apps/api/src/views.ts`).
- `/api/alerts/:id` returns `document: null` for a stored document that fails `publicAlertDocument`. A read checks the rules; it does not rewrite the stored row.
- A Discord card is built only from a document that passes the same check (`packages/delivery/src/execute.ts`). Its source link is left out when it is not a public link (`packages/delivery/src/render/discord.ts`).

## Limits of these rules

They govern the shape of a URL. They do not inspect a path or a query, they do not know what a page serves, and they do not cover anything that is not written as a link.

Fetching a page is separate and stricter (`packages/sources/src/web.ts`): HTTPS on port 443, no userinfo, no IP literal, no denied domain, at most 32 DNS answers per hop and every answer a public address.

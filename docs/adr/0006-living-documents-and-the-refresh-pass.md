# ADR-0006: Living documents and the refresh pass

- **Status**: Accepted. Amends [ADR-0002](./0002-b2-durable-work.md).
- **Date**: 2026-11-23 (written down on 2026-11-24, after the change had shipped)

## Context

ADR-0002 persists one validated document per language in the same transaction as the alert and its deliveries, and treats that document as final. Three properties of the product made that too rigid:

- Analysis starts on a thin discussion. The deep gate lets a Hacker News story through on few comments so that the reading is not late, on the understanding that the discussion grows afterwards (`hn.deep_gate` in `packages/contracts/src/config.ts`).
- Every published document is read in one language. The desk and the cards are Simplified Chinese (`profile.output_lang`), so writing English first and translating it paid for two model calls per document.
- The model routes in use occasionally let a JSON fragment or a citation slip into a string field (`tools/local/run.ts`), and a model that loses its place repeats a phrase (`packages/analysis/src/finalization.ts`). The deterministic cleaner in `packages/analysis/src/finalization.ts` removes the patterns it knows.

## Decision

This amends the second paragraph of ADR-0002. A document is still persisted in the same transaction as the alert and its deliveries, but it is no longer written in English and translated, and it is no longer final after the first alert.

- **One language, written directly.** Deep analysis writes the document in `profile.output_lang` (`packages/analysis/src/finalization.ts`). The translator runs only for another language that an enabled alert destination asks for (`packages/analysis/src/deep.ts`).
- **A polish pass after deep analysis.** Once a document is drafted, a second model call rewrites its summary and the reading of each point and nothing else (`packages/analysis/src/polish.ts`, `packages/prompts/src/polish.ts`). The prompt pins the number of points, and the answer is discarded unless it keeps that number and leaves no field empty, so a bad pass costs one call and changes nothing. The pass has no route of its own: it runs on the translator's (`stageModels` in `packages/contracts/src/config.ts`) and debits its own daily scope `ai:polish` under the `deep_per_day` limit (`packages/analysis/src/work.ts`).
- **A published story is refreshed.** On every tick, Hacker News stories that already have a reading go back through deep analysis (`refreshPublishedItems` in `packages/ingestion/src/refresh.ts`): those updated at least `ai.refresh_interval_minutes` ago, younger than `ai.refresh_max_age_hours`, and whose discussion is estimated to have grown by `ai.refresh_min_new_comments` since the analysis. The pass receives the item's latest reading, and the comments that reading already cited go last, so the bounded comment budget goes to what is new (`packages/analysis/src/evidence.ts`).
- **The page follows the reading.** A refreshed reading is finalized as an alert of kind `update` for the same item (`draftAlert` in `packages/analysis/src/finalization.ts`), and the item page shows the newest alert's document (`apps/web/src/main.ts`). When the same alert key is finalized again, `makeFinalizer` in `apps/pipeline/src/worker.ts` keeps the alert row and, while `delivery.feed_only` is on, overwrites its documents.
- **A link can withhold a document.** A quote that fails verification is dropped from the page. A link in the prose that cannot be published withholds the whole document (`packages/analysis/src/finalization.ts`, `packages/kernel/src/public-links.ts`).

## Alternatives

- Keep writing English and translating it. That is two model calls per document, and a reading can fail the fidelity check on its way to the reader's language.
- Wait for a discussion to mature before the first analysis. That costs the lead time the product exists to capture.
- Publish once and never refresh. A story analyzed on three comments would keep that first reading.
- Rely on the deterministic cleaner alone. It removes only the patterns that were known in advance.

## Consequences

- A fresh analysis costs up to three kinds of model call: deep, polish, and one translation per other destination language. Each debits its own stage scope against the daily budget (`packages/analysis/src/work.ts`).
- A replay of an item that is already analyzed calls no model (`packages/analysis/src/deep.ts`).
- A story can have more than one alert. `/api/items/:id` returns their history, newest first, and the page shows the newest.
- A refresh that decides `send` is planned against the destinations like a first alert. The update limit `delivery.max_updates_per_item` bounds how many `update` alerts per item are sent (`claimForSend` in `packages/storage/src/d1.ts`).
- The polish prompt is versioned as `polish-v1` (`packages/prompts/src/versions.ts`). A change to the prompt or to its output contract needs a new version, or a stored analysis is reused for a different prompt.

## Review Triggers

Revisit this decision when documents are published in a second language for readers rather than for destinations, when the polish pass gets a model route of its own, when the readings of a story have to be kept as a history, or when a document has to be refreshed on a schedule of its own.

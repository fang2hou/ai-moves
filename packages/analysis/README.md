# Analysis

`@ai-moves/analysis/triage` consumes `q-triage` jobs for changelog candidates. Legacy HN candidates advance directly to Deep without a model call or triage budget debit. `@ai-moves/analysis/deep` consumes `q-deep` jobs for triage passes: it collects evidence, runs the deep model call, polishes the result, translates where a destination needs it, and hands the alert to the injected `FinalizeAlert` (`@ai-moves/analysis/finalization` drafts it). Both take injected ports; neither sends a notification or selects an adapter.

## Claims, budgets, and replay

- A consumer first wins the item-state compare-and-set. Each analysis stage then needs its own analysis lease and a durable budget receipt before `LlmClient.generateStructured` runs. Scopes are per stage (`ai:triage`, `ai:deep`, `ai:polish`, `ai:translate`, per UTC day); triage uses `ai.triage_items_per_day` and every other stage `ai.deep_per_day` (300 by default for each stage). A receipt bounds one port call, not the adapter's internal repair and fallback requests.
- Changelog triage also debits `ai:triage:repo:<owner>/<repo>` or `ai:triage:site:<hostname>` against `changelog.max_triage_per_repo_per_day` (default 3), first, so a busy source cannot drain the shared budget.
- Analysis rows are keyed by item, stage, input hash, prompt version, and language. The input hash comes from `itemSnapshotHash`. The first prepared input is pinned in content-addressed blob storage, referenced by the row's `blob_key`, before the model call, so retries never re-fetch changed evidence and a replay never calls a model.
- Retryable failures leave rows pending until the lease expires and persist an item backoff; a completed row stays reusable after attempts run out. Drain or migrate `analyzed` work before changing a prompt version.

Each claimed refresh increments the item revision. Deep analysis reads the previous document and prioritizes comments it did not cite. Finalization replaces the original alert documents in place with `replaceDocuments`, preserving its decision and deliveries. A retry reuses the analysis for that revision. If retries run out, the item returns to its published state and the desk serves its last document. An item without its own published alert enters `failed_analysis`.

## Evidence and documents

- Changelog evidence is the normalized revision notes in blob storage, read through the revision's `blob_key`; HN evidence is the article or self-post plus a bounded comment selection. Only evidence whose locator is a publishable link reaches the prompt.
- Deep analysis writes `profile.output_lang` directly. A polish pass repairs the summary and points and is accepted only when it keeps the same facts; `cleanModelText` then strips leaked citations, URLs, and JSON fragments from prose and the headline.
- Cited quotes must match the recorded evidence verbatim. Unverified quotes are dropped from the page, and any rejected quote blocks a `send` decision. A document is withheld only when one of its links cannot be published.
- Translations are made only for a `send` decision and only for other non-English languages an enabled alert destination needs; `src/deep.ts` skips `en`. While `output_lang` is set to a language other than the default `en`, an English destination therefore gets no document, and `planDeliveries` plans no delivery for it. Translations keep the shape of the prose fields; quotes and original titles are copied untranslated. A failed translation yields no document for that language, never an English fallback under its ID.

Finalization must be idempotent under the alert key. An `analyzed` replay rebuilds documents from durable outputs without source or model calls.

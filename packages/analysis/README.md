# Analysis

`@ai-moves/analysis/triage` consumes `q-triage` jobs for changelog candidates and submissions sent in `score` mode (a `publish` submission skips triage and enters Deep directly). Legacy HN candidates advance directly to Deep without a model call. `@ai-moves/analysis/deep` consumes `q-deep` jobs for triage passes: it collects evidence, runs the deep model call, polishes the result, translates where a destination needs it, and hands the alert to the injected `FinalizeAlert` (`@ai-moves/analysis/finalization` drafts it). Both take injected ports; neither sends a notification or selects an adapter. `@ai-moves/analysis/relevance` builds the `HnRelevanceJudge` the HN poll calls: one model call labels a batch of stories, logs `analysis.hn_relevance_judged` with token usage, and on any failure logs `analysis.hn_relevance_failed` and returns no verdicts.

## Submissions

A `submission` item (markdown a signed-in reader sent through MCP) is analyzed like a release without a discussion. Evidence is the stored revision markdown cited under the item's own URL, and the card's source line is that URL's host; the sentinel source row supplies nothing. Deep validates the result with `SubmissionDeepAssessmentSchema` and writes the card in the deployment's output language. Finalization copies only the submitter's display name from `score_json` into the document's `submitted_by`; the email never reaches a document, alert row, or prompt. Its decision reason records the model's importance.

## Claims and replay

- A consumer first wins the item-state compare-and-set. Each analysis stage then needs its own lease before `LlmClient.generateStructured` runs.
- HN gates and changelog prior scores govern admission. Set `ai.enabled: false` in the published configuration to pause new claims and leave ready items eligible for the sweep after re-enabling AI.
- Analysis rows are keyed by item, stage, input hash, prompt version, and language. The input hash comes from `itemSnapshotHash`. The first prepared input is pinned in content-addressed blob storage, referenced by the row's `blob_key`, before the model call, so retries never re-fetch changed evidence and a replay never calls a model.
- Retryable failures leave rows pending until the lease expires and persist an item backoff; a completed row stays reusable after attempts run out. Drain or migrate `analyzed` work before changing a prompt version.

Each claimed refresh increments the item revision. Deep analysis reads the previous document and prioritizes comments it did not cite. Finalization replaces the original alert documents in place with `replaceDocuments`, preserving its decision and deliveries. A retry reuses the analysis for that revision. If retries run out, the item returns to its published state and the desk serves its last document. An item without its own published alert enters `failed_analysis`.

## Evidence and documents

- Changelog evidence is the normalized revision notes in blob storage, read through the revision's `blob_key`; HN evidence is the article or self-post plus a bounded comment selection. Only evidence whose locator is a publishable link reaches the prompt.
- Deep analysis writes `profile.output_lang` directly. A polish pass repairs the summary and points and is accepted only when it keeps the same facts; `cleanModelText` then strips leaked citations, URLs, and JSON fragments from prose and the headline.
- Cited quotes must match the recorded evidence verbatim. Unverified quotes are dropped from the page, and any rejected quote blocks a `send` decision. A document is withheld only when one of its links cannot be published.
- Translations are made only for a `send` decision and only for other non-English languages an enabled alert destination needs; `src/deep.ts` skips `en`. While `output_lang` is set to a language other than the default `en`, an English destination therefore gets no document, and `planDeliveries` plans no delivery for it. Translations keep the shape of the prose fields; quotes and original titles are copied untranslated. A failed translation yields no document for that language, never an English fallback under its ID.

Finalization must be idempotent under the alert key. An `analyzed` replay rebuilds documents from durable outputs without source or model calls.

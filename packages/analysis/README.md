# Analysis

`@ai-moves/analysis/triage` consumes candidate jobs. `@ai-moves/analysis/deep` consumes
triage passes, collects evidence, and prepares verified alert documents. Both accept
injected ports; neither sends a notification or selects an adapter.

## Claims and replay

- A consumer first wins the item-state CAS. Each pending analysis stage and language then needs
  its own analysis lease and a receipt before `LlmClient.generateStructured` can run. UTC scopes
  `ai:triage`, `ai:deep`, and `ai:translate` are separate. Translation uses `deep_per_day` as
  its independent daily invocation limit. A receipt bounds a port invocation, not the adapter's
  internal repair and fallback requests.
- Rows keep the existing `(item, stage, input hash, prompt version, language)` key. The input hash
  identifies the item snapshot (and triage heat tier for HN), or the deep result plus source prose
  for translation. The first prepared input is pinned in a content-addressed blob before a model
  call; retries do not re-fetch changed evidence. `output_json.value` contains the normalized
  assessment or translation. Sibling fields record the actual model, configuration version,
  repair, and fallback; `usage_json` records reported usage.
- Retryable failures leave analysis rows pending until lease expiry and persist item backoff.
  A new invocation needs a fresh debit. A completed row is reusable after attempt exhaustion;
  the sweeper must redispatch an expired last claim once so the consumer can check for completed
  work before failing the item. Schedule `triaged_pass` and `analyzed` items from storage even
  if a prior queue send appeared to succeed. Drain or migrate `analyzed` work before changing
  prompt versions: version 1 item rows carry no analysis checkpoint pointer.

## Evidence and finalization

Changelog revisions are normalized UTF-8 notes at `ItemRevision.r2_key`. HN uses `hn:<story-id>`
and fetches the article or self-post and a bounded comment selection. Every cited locator and
verbatim quote must match the recorded prompt evidence. Missing or invalid evidence produces
feed-only output. Links and document identities come from program-owned inputs.

Translations preserve the shape and order of the prose fields, and check the target script,
detectable names and identifiers, code, commands, versions, and URLs. Quotes and original titles
are copied without translation. These deterministic checks cannot prove semantic equivalence.
An unavailable or rejected translation yields no document for that language, never an English
fallback under that language's ID.

Composition injects `FinalizeAlert` from the `/finalization` subpath. Plan deliveries only for
languages with verified documents, persist them atomically with the alert, and return the
canonical alert. Finalization must be idempotent under the alert key and may wake existing
deliveries. An `analyzed` replay reconstructs documents from durable outputs without source or
model calls.

## Verification

```bash
pnpm --filter @ai-moves/analysis test
```

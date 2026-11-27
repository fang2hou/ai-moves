# Prompts

`@ai-moves/prompts/triage`, `/deep`, `/polish`, and `/translate` render structured generation requests from program-selected inputs, each with a strict model-facing schema. Pass the rendered request to `LlmClient`, and use its `promptVersion` in the analysis key. Bump the matching value in `@ai-moves/prompts/versions` whenever a template or its output contract changes.

- **HN relevance** (`/relevance`, `HN_RELEVANCE_PROMPT_VERSION`) labels a batch of Hacker News stories `core`, `adjacent`, or `unrelated` from their titles and links in one request on the triage route. It writes no analysis row.
- **Triage** decides pass or reject; `normalizeTriageOutput` drops the model-only null rejection reason on a pass, and a reject must carry a reason.
- **Deep** selects the HN, changelog, or submission schema by item kind and returns a contract assessment directly. It writes every prose field in the requested output language, names the reader's products from `profile.products`, asks changelog points for a category (breaking, new, change, fix), and, when a prior reading is supplied, updates it instead of starting over. A submission is briefed from the reader's excerpt as the source: points carry no category, importance runs 1 to 5 as for a Hacker News story, and `community_view` is null.
- **Polish** rewrites a finished summary and its points in place; the number of points is pinned and every field keeps its length limit.
- **Translate** returns only translated prose in the same positions. Quotes, citation metadata, links, and alert metadata stay program-owned, and the consumer checks fidelity before using the result.

Source and profile data are serialized separately from the system instructions. Templates make no outbound decisions and give the model no tools.

Templates use English instructions. [Locale packs](../locales/README.md) provide language names, natural-writing rules for deep analysis, and citation examples for polishing. Analysis uses all registered citation prefixes to remove leaked citations regardless of document language.

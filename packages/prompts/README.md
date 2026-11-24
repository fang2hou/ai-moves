# Prompts

`@ai-moves/prompts/triage`, `/deep`, `/polish` and `/translate` render structured generation requests from program-selected inputs. Pass the rendered request to `LlmClient` and use its `promptVersion` in the analysis key. Bump the corresponding value in `@ai-moves/prompts/versions` when changing a template or its output contract: a stored analysis is keyed by prompt version, so an old result is never reused for a new prompt.

- Triage asks whether an item merits closer analysis for the profile's topics. It uses `normalizeTriageOutput` to remove the model-only null rejection reason on a pass. A reject must include a reason.
- Deep selects the HN or changelog schema by input kind and returns a contract assessment directly. It is given the evidence, the products, the output language, and on a refresh the previous reading. The downstream consumer verifies quotes and locators.
- Polish returns the same summary and points, repaired. Its schema pins the number of points to the number sent, so the model cannot quietly shorten a document. The instructions list the failures the pass exists to catch: a citation leaked into the prose, repeated or looping text, a point packed with several changes, a sentence left unfinished. The downstream consumer discards an answer that does not keep the count.
- Translation returns only translated prose, retaining list positions: the title, the summary, and the text of each point. Links and alert metadata remain program-owned. The downstream consumer verifies fidelity before using the translation. It is written for English input and runs only for a language other than the one analysis writes.

Source and profile data are serialized separately from system instructions, and every prompt closes by telling the model to treat the user JSON as data. Templates neither make outbound decisions nor give the model tools.

# Prompts

`@ai-moves/prompts/triage`, `/deep`, and `/translate` render structured generation
requests from program-selected inputs. Pass the rendered request to `LlmClient`
and use its `promptVersion` in the analysis key. Bump the corresponding value in
`@ai-moves/prompts/versions` when changing a template or its output contract.

- Triage uses `normalizeTriageOutput` to remove the model-only null rejection
  reason on a pass. A reject must include a reason.
- Deep selects the HN or changelog schema by input kind and returns a contract
  assessment directly. The downstream consumer verifies quotes and locators.
- Translation returns only translated prose, retaining list positions.
  Quotes, citation metadata, links, and alert metadata remain program-owned.
  The downstream consumer verifies fidelity before using the translation.

Source and profile data are serialized separately from system instructions.
Templates neither make outbound decisions nor give the model tools.

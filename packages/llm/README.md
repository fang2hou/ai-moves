# LLM adapters

`@ai-moves/llm/openrouter` and `@ai-moves/llm/bedrock` implement the provider-agnostic `LlmClient` port from `@ai-moves/contracts/ports/llm` on OpenRouter and on Claude in Amazon Bedrock. A route's `provider` (`openrouter` or `bedrock`) selects the adapter; every stage uses one provider, the Worker admits only `openrouter`, and the Lambda entry admits both (`deploymentConfigIssue` in `apps/pipeline/src/pipeline.ts`). `pipelineConfigIssue` in `@ai-moves/contracts/config` checks only provider-neutral invariants.

Compose the adapter with an injected `HttpFetch`, a `SecretProvider` and secret reference, the configured stage routes (`stageModels`: triage, deep, translate, and polish on the translate route) with output-token caps, and a per-attempt deadline. It obtains its credential through the port at construction and forwards neither the trace ID nor credentials into prompt data or error details.

- Requests use non-streaming [Chat Completions][chat] with [strict structured outputs][structured], `require_parameters: true`, and provider fallbacks disabled; the result is validated locally against the caller's schema.
- At most 256 KiB of decoded response bytes are read under the per-attempt deadline; oversized completions are invalid upstream responses, and HTTP error bodies are discarded.
- Invalid model output gets one repair attempt on the same route. A failure that is eligible for fallback then tries each configured fallback route in turn. A rate-limited route falls back immediately; other failures fall back only when retryable or invalid and without a provider `Retry-After` hint. Permanent rejections and credit errors never fall back.
- `repaired` and `usedFallback` identify the successful attempt. Returned [usage][usage] sums reported tokens and USD cost across attempts, including failed generations; cost is `null` if any reported usage lacks it. Provider payloads are not persisted, and the [error mapping][errors] keeps classification and retry-delay hints without upstream messages.

The adapter enables no tool calling, plugins, or hidden provider fallbacks.

## Claude in Amazon Bedrock

`createBedrockClaudeClient` calls the Messages API at `https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages` with `anthropic-version: 2026-10-21`. It receives a `fetch` that signs for the `bedrock-mantle` service (`createSignedFetch` in `@ai-moves/runtime-aws/signed-fetch`), so it holds no credential and reads no secret; the execution role needs `bedrock-mantle:CreateInference` on the routed models.

- Route models are Bedrock IDs with the `anthropic.` prefix, for example `anthropic.claude-sonnet-5-5`. A route's optional `effort` is sent as `output_config.effort`; thinking stays at the model default and no sampling parameters are sent.
- System messages become the top-level `system` field. Output uses `output_config.format` with a JSON schema from `claude-schema.ts`, which moves the keywords Claude rejects (`minLength`, `maxLength`, `minimum`, `maximum`, `maxItems`, and the like) into the node's description, turns `oneOf` into `anyOf`, and fails with `CONFIG_INVALID` before any request if a keyword outside the accepted subset remains. The caller's zod schema still validates every constraint locally.
- The answer is the first `text` block; leading thinking blocks are ignored. `max_tokens` and any other stop reason than `end_turn` are `LLM_OUTPUT_INVALID`, which gets the same single repair attempt as on OpenRouter.
- A `refusal` stop reason is `UPSTREAM_REJECTED` with the refusal category in the error context. Unlike other rejections it tries the fallback routes, because Bedrock has no server-side fallback; the seeded Bedrock routes fall back to `anthropic.claude-sonnet-5`.
- Bedrock reports tokens but not cost, so `cost_usd` is `null`; cache reads and writes count as input tokens. Requests are not streamed, so keep `timeouts.llm_ms` below the 300-second header timeout of Node's `fetch`.

[chat]: https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
[structured]: https://openrouter.ai/docs/guides/features/structured-outputs
[usage]: https://openrouter.ai/docs/cookbook/administration/usage-accounting
[errors]: https://openrouter.ai/docs/api_reference/errors-and-debugging

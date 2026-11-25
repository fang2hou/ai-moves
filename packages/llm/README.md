# LLM adapters

`@ai-moves/llm/openrouter` implements the provider-agnostic `LlmClient` port from `@ai-moves/contracts/ports/llm` on OpenRouter. A Bedrock or other provider for Phase 2 is another adapter in this package behind the same port; the pipeline currently admits only `openrouter` routes (`deploymentConfigIssue` in `apps/pipeline/src/pipeline.ts`). `pipelineConfigIssue` in `@ai-moves/contracts/config` checks only provider-neutral invariants.

Compose the adapter with an injected `HttpFetch`, a `SecretProvider` and secret reference, the configured stage routes (`stageModels`: triage, deep, translate, and polish on the translate route) with output-token caps, and a per-attempt deadline. It obtains its credential through the port at construction and forwards neither the trace ID nor credentials into prompt data or error details.

- Requests use non-streaming [Chat Completions][chat] with [strict structured outputs][structured], `require_parameters: true`, and provider fallbacks disabled; the result is validated locally against the caller's schema.
- At most 256 KiB of decoded response bytes are read under the per-attempt deadline; oversized completions are invalid upstream responses, and HTTP error bodies are discarded.
- Invalid model output gets one repair attempt on the same route. A failure that is eligible for fallback then tries each configured fallback route in turn. A rate-limited route falls back immediately; other failures fall back only when retryable or invalid and without a provider `Retry-After` hint. Permanent rejections and credit errors never fall back.
- `repaired` and `usedFallback` identify the successful attempt. Returned [usage][usage] sums reported tokens and USD cost across attempts, including failed generations; cost is `null` if any reported usage lacks it. Provider payloads are not persisted, and the [error mapping][errors] keeps classification and retry-delay hints without upstream messages.

The adapter enables no tool calling, plugins, or hidden provider fallbacks.

[chat]: https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
[structured]: https://openrouter.ai/docs/guides/features/structured-outputs
[usage]: https://openrouter.ai/docs/cookbook/administration/usage-accounting
[errors]: https://openrouter.ai/docs/api_reference/errors-and-debugging

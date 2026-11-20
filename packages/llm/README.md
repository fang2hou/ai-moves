# OpenRouter adapter

`@ai-moves/llm/openrouter` implements `LlmClient`. Compose it with an injected
`HttpFetch`, a `SecretProvider` and secret reference, configured stage models
and output-token caps, and a per-attempt deadline. The adapter obtains its
credential through the port at construction; it forwards neither the trace
identifier nor credentials into prompt data or error details.

The adapter uses non-streaming [Chat Completions][chat] with
[strict structured outputs][structured] and validates the result locally. It
tries one repair on invalid model output, regenerating without reusing the
rejected output; eligible failures can use the first configured fallback once.
It never retries after a permanent rejection, a credit error, or a provider
`Retry-After` hint. Tool calling, plugins, and hidden provider fallbacks are
not enabled by the adapter.

`repaired` and `usedFallback` identify the successful attempt. Returned
[usage][usage] sums reported tokens and USD cost across attempts, including
failed generations with reported usage. Cost is `null` if any reported usage
lacks cost. Provider payloads and usage are not persisted by the adapter.
The [error mapping][errors] preserves classification and retry-delay hints
without exposing upstream messages.

[chat]: https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
[structured]: https://openrouter.ai/docs/guides/features/structured-outputs
[usage]: https://openrouter.ai/docs/cookbook/administration/usage-accounting
[errors]: https://openrouter.ai/docs/api_reference/errors-and-debugging

# LLM adapters

The adapters implement `LlmClient` from `@ai-moves/contracts/ports/llm`. A route's `provider` selects its adapter. Workers and Lambda both admit `openrouter` and `hyper`. Lambda also admits `bedrock` and `bedrock-runtime`.

Compose the adapter with an injected `HttpFetch`, a `SecretProvider` and secret reference, the configured stage routes (`stageModels`: triage, deep, translate, and polish on the translate route) with output-token caps, and a per-attempt deadline. It obtains its credential through the port at construction and forwards neither the trace ID nor credentials into prompt data or error details.

## OpenRouter and Charm Hyper

- `@ai-moves/llm/openrouter` reads `OPENROUTER_API_KEY` in the pipeline. Its non-streaming [Chat Completions][chat] requests use [strict structured outputs][structured], `require_parameters: true`, and provider fallbacks disabled. OpenRouter routes take no `effort`.
- `@ai-moves/llm/hyper` reads `HYPER_API_KEY` in the pipeline and sends strict, non-streaming JSON-schema requests to `POST https://hyper.charm.land/v1/chat/completions`. DeepSeek routes such as `deepseek-v4.1-flash-1017-economy`, `deepseek-v4.1-flash-1017`, and `deepseek-v4-pro-0813` take `low`, `high`, or `max` effort via `reasoning_effort`. Omitting `effort` uses the provider default.
- Both adapters validate returned content against the caller's schema. Hyper's `usage.cost` contains `usd` and `hypercredits`. Accounting uses `usd` from Hyper and the numeric `usage.cost` from OpenRouter.
- At most 256 KiB of decoded response bytes are read under the per-attempt deadline; oversized completions are invalid upstream responses, and HTTP error bodies are discarded.
- Invalid model output gets one repair attempt on the primary model. Eligible failures then try the `fallbacks` list within that provider. Rate limiting advances immediately. Other retryable or invalid responses advance when they carry no `Retry-After` hint. Permanent rejections, including an HTTP 402 without a retry hint, end that provider's model chain.
- `repaired` and `usedFallback` identify the successful attempt. Returned [usage][usage] sums reported tokens and USD cost across attempts, including failed generations; cost is `null` if any reported usage lacks it. Provider payloads are not persisted, and the [error mapping][errors] keeps classification and retry-delay hints without upstream messages.

The adapter enables no tool calling, plugins, or hidden provider fallbacks.

## Cross-provider fallback

All primary stages share one provider. Each stage can set up to three ordered `fallback_routes` with `provider`, `model`, optional `fallbacks`, and optional `effort`. Each route inherits the stage's `max_output_tokens`. Polish uses the translate stage's routes. The shared pipeline checks provider availability and effort for every route before running jobs. Existing configurations default to an empty list.

The pipeline advances after the current provider's repair and model fallback policy finishes. A missing key, rate limit (429 or 402 with `Retry-After`), service or network failure, timeout (408, 504, or the attempt deadline), invalid response, invalid output, or a rejection with HTTP 402 can advance to the next provider. Invalid requests, authentication failures, permission and model errors (400, 401, 403, and 404), and content filtering end the provider chain. Misconfigured credentials surface directly.

Each fallback provider is constructed only when it is reached. A successful switch returns `usedFallback: true` with that provider's accumulated usage. `timeouts.llm_ms` applies per attempt, so account for the configured chains when setting the analysis lease and runtime time limits.

## Claude on Amazon Bedrock

`createBedrockClaudeClient` has two transports, chosen by the route's provider in the Lambda entry:

| Provider          | Transport  | Request                                                                                                                         | Signed for       | IAM action                                                               |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `bedrock`         | `messages` | `POST https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages`, `anthropic-version: 2026-10-21`, `model` in the body      | `bedrock-mantle` | `bedrock-mantle:CreateInference`                                         |
| `bedrock-runtime` | `invoke`   | `POST https://bedrock-runtime.{region}.amazonaws.com/model/{model}/invoke`, `anthropic_version: bedrock-2023-05-31` in the body | `bedrock`        | `bedrock:InvokeModel` on the inference profile and its foundation models |

The adapter receives a `fetch` that signs for that service (`createSignedFetch` in `@ai-moves/runtime-aws/signed-fetch`), so it holds no credential and reads no secret. `messages` routes name Bedrock model IDs such as `anthropic.claude-sonnet-5-5`; `invoke` routes also accept inference profiles such as `global.anthropic.claude-sonnet-5-5` or `jp.anthropic.claude-sonnet-4-6`.

- A route's optional `effort` is sent as `output_config.effort`; thinking stays at the model default and no sampling parameters are sent.
- System messages become the top-level `system` field. Output uses `output_config.format` with a JSON schema from `claude-schema.ts`, which moves the keywords Claude rejects (`minLength`, `maxLength`, `minimum`, `maximum`, `maxItems`, and the like) into the node's description, turns `oneOf` into `anyOf`, and fails with `CONFIG_INVALID` before any request if a keyword outside the accepted subset remains. The caller's zod schema still validates every constraint locally.
- The answer is the first `text` block; leading thinking blocks are ignored. `max_tokens` and any other stop reason than `end_turn` are `LLM_OUTPUT_INVALID`, which gets the same single repair attempt as on OpenRouter.
- Besides the OpenRouter fallback rules, two Bedrock rejections try the next route: a `refusal` stop reason (`UPSTREAM_REJECTED` with the category in the error context), because Bedrock has no server-side fallback, and a 400, 403, or 404, which Bedrock returns for a model the account has not enabled or the region does not serve. List routes from most to least preferred, and end with a model known to be enabled.
- Bedrock reports tokens but not cost, so `cost_usd` is `null`; cache reads and writes count as input tokens. Requests are not streamed, so keep `timeouts.llm_ms` below the 300-second header timeout of Node's `fetch`.

[chat]: https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
[structured]: https://openrouter.ai/docs/guides/features/structured-outputs
[usage]: https://openrouter.ai/docs/cookbook/administration/usage-accounting
[errors]: https://openrouter.ai/docs/api_reference/errors-and-debugging

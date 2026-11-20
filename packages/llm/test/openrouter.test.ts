import { TriageAssessmentSchema } from "@ai-moves/contracts/analysis";
import type { GenerateStructuredRequest } from "@ai-moves/contracts/ports/llm";
import type { HttpFetch } from "@ai-moves/contracts/ports/runtime";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { loadFixture } from "@ai-moves/testing/node/fixtures";
import { createMockUpstream } from "@ai-moves/testing/upstream/mock-upstream";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createOpenRouterClient } from "../src/openrouter.ts";

const schema = TriageAssessmentSchema.options[0].extend({
  kind: z.literal("hn"),
  rejection_reason: z.null(),
});
const request = {
  stage: "triage",
  traceId: "trace-synthetic",
  schemaName: "triage-v1",
  schema,
  messages: [{ role: "user", content: '{"title":"Package release"}' }],
} as const satisfies GenerateStructuredRequest<z.infer<typeof schema>>;
const pass = { kind: "hn", decision: "pass", confidence: 0.85, rejection_reason: null };
const secretRef = "TEST_OPENROUTER_KEY";
const syntheticCredential = "synthetic-fixture";
const primary = "example/compact";
const fallback = "example/fallback";

function replay(finalScenario: string, ...firstScenarios: string[]) {
  const mock = createMockUpstream();
  const route = mock.replay(loadFixture("openrouter", finalScenario));
  for (const scenario of firstScenarios) {
    const { status, body, headers } = loadFixture("openrouter", scenario).response;
    route.replyOnce(status, body, headers);
  }
  return { mock, route };
}

function client(fetch: HttpFetch, fallbacks: string[] = [], timeoutMs = 1000) {
  return createOpenRouterClient({
    fetch: (outgoing) => {
      expect(outgoing.headers.get("authorization")).toBe(`Bearer ${syntheticCredential}`);
      outgoing.headers.delete("authorization");
      return fetch(outgoing);
    },
    secrets: {
      get(ref) {
        expect(ref).toBe(secretRef);
        return Promise.resolve(syntheticCredential);
      },
    },
    secretRef,
    models: {
      triage: { model: primary, fallbacks, max_output_tokens: 50 },
      deep: { model: "example/large", fallbacks: [], max_output_tokens: 2000 },
      translate: { model: "example/translator", fallbacks: [], max_output_tokens: 1500 },
    },
    timeoutMs,
  });
}

function sentBodies(mock: ReturnType<typeof createMockUpstream>): unknown[] {
  expect(mock.unexpected).toEqual([]);
  expect(mock.pendingScripts()).toBe(0);
  return mock.requests.map((sent): unknown => JSON.parse(sent.body));
}

describe("OpenRouter structured completions", () => {
  it("requests a strict bounded completion and maps the model and usage returned by OpenRouter", async () => {
    const { mock } = replay("triage-pass");
    const llm = await client(mock.fetch);
    await expect(llm.generateStructured(request)).resolves.toEqual({
      output: pass,
      model: "example/compact-2026-01",
      usage: { input_tokens: 40, output_tokens: 12, cost_usd: 0.001 },
      repaired: false,
      usedFallback: false,
    });
    expect(sentBodies(mock)).toEqual([
      {
        model: primary,
        messages: request.messages,
        max_tokens: 50,
        stream: false,
        provider: { require_parameters: true, allow_fallbacks: false },
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "triage-v1",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", const: "hn" },
                decision: { type: "string", const: "pass" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                rejection_reason: { type: "null" },
              },
              required: ["kind", "confidence", "decision", "rejection_reason"],
            },
          },
        },
      },
    ]);
  });

  it("selects the stage's model and token cap independently of the schema", async () => {
    const { mock } = replay("triage-pass");
    const llm = await client(mock.fetch);
    await llm.generateStructured({ ...request, stage: "deep" });
    expect(sentBodies(mock)).toEqual([
      expect.objectContaining({ model: "example/large", max_tokens: 2000 }),
    ]);
  });

  it.each([
    ["malformed-output", 80, 18],
    ["unknown-field", 82, 27],
  ])("repairs %s once and accounts for both attempts", async (scenario, input, output) => {
    const { mock } = replay("triage-pass", scenario);
    const llm = await client(mock.fetch, [fallback]);
    await expect(llm.generateStructured(request)).resolves.toMatchObject({
      output: pass,
      repaired: true,
      usedFallback: false,
      usage: { input_tokens: input, output_tokens: output, cost_usd: 0.002 },
    });
    expect(sentBodies(mock)).toEqual([
      expect.objectContaining({ model: primary, messages: request.messages }),
      expect.objectContaining({
        model: primary,
        messages: [
          ...request.messages,
          {
            role: "user",
            content:
              "The previous completion did not match the response schema. Regenerate from the original input, following the schema exactly. Return only the JSON object.",
          },
        ],
      }),
    ]);
  });

  it("uses the first fallback after exhausting repair and includes reported usage from failed generations", async () => {
    const { mock } = replay("fallback-pass", "malformed-output", "unknown-field");
    const llm = await client(mock.fetch, [fallback, "example/unused"]);
    await expect(llm.generateStructured(request)).resolves.toMatchObject({
      output: { ...pass, confidence: 0.9 },
      model: "example/fallback-2026-01",
      usage: { input_tokens: 122, output_tokens: 34, cost_usd: null },
      repaired: false,
      usedFallback: true,
    });
    expect(sentBodies(mock)).toEqual([
      expect.objectContaining({ model: primary }),
      expect.objectContaining({ model: primary }),
      expect.objectContaining({ model: fallback, messages: request.messages }),
    ]);
  });

  it.each([
    [[], 2],
    [[fallback, "example/unused"], 3],
  ] as const)("does not retry indefinitely with fallbacks %j", async (fallbacks, attempts) => {
    const { mock } = replay("unknown-field");
    const llm = await client(mock.fetch, [...fallbacks]);
    await expect(llm.generateStructured(request)).rejects.toMatchObject({
      code: "LLM_OUTPUT_INVALID",
    });
    expect(sentBodies(mock)).toHaveLength(attempts);
  });

  it.each([
    ["bad-request", "UPSTREAM_REJECTED", undefined, true],
    ["credits-exhausted", "BUDGET_EXHAUSTED", undefined, true],
    ["rate-limited", "UPSTREAM_RATE_LIMITED", 7000, true],
    ["unavailable", "UPSTREAM_UNAVAILABLE", undefined, false],
    ["invalid-envelope", "UPSTREAM_RESPONSE_INVALID", undefined, false],
    ["embedded-error", "UPSTREAM_UNAVAILABLE", undefined, false],
  ] as const)(
    "classifies %s without exposing its response body",
    async (scenario, code, retryAfterMs, hasFallback) => {
      const { mock } = replay(scenario);
      const llm = await client(mock.fetch, hasFallback ? [fallback] : []);
      await expect(llm.generateStructured(request)).rejects.toMatchObject({
        code,
        message: code,
        retryAfterMs,
      });
      expect(sentBodies(mock)).toHaveLength(1);
    },
  );

  it("falls back immediately on an unavailable primary without a repair", async () => {
    const { mock } = replay("fallback-pass", "unavailable");
    const llm = await client(mock.fetch, [fallback]);
    await expect(llm.generateStructured(request)).resolves.toMatchObject({
      model: "example/fallback-2026-01",
      usedFallback: true,
    });
    expect(sentBodies(mock)).toEqual([
      expect.objectContaining({ model: primary, messages: request.messages }),
      expect.objectContaining({ model: fallback, messages: request.messages }),
    ]);
  });

  it("aborts a slow response body and returns an upstream timeout", async () => {
    vi.useFakeTimers();
    try {
      const { mock, route } = replay("triage-pass");
      const bodyStarted = Promise.withResolvers<AbortSignal>();
      route.replyWith(
        (outgoing) =>
          new Response(
            new ReadableStream({
              start(controller) {
                outgoing.signal.addEventListener(
                  "abort",
                  () => controller.error(outgoing.signal.reason),
                  { once: true },
                );
                bodyStarted.resolve(outgoing.signal);
              },
            }),
          ),
      );
      const llm = await client(mock.fetch, [], 100);
      const failure = llm.generateStructured(request).catch((error: unknown) => error);
      const signal = await bodyStarted.promise;
      await vi.advanceTimersByTimeAsync(100);
      expect(await failure).toMatchObject({ code: "UPSTREAM_TIMEOUT" });
      expect(signal.aborted).toBe(true);
      expect(sentBodies(mock)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails at composition when the secret is unbound without contacting the upstream", async () => {
    const { mock } = replay("triage-pass");
    const route = { model: primary, fallbacks: [], max_output_tokens: 50 };
    await expect(
      createOpenRouterClient({
        fetch: mock.fetch,
        secrets: { get: () => Promise.reject(new AppError("SECRET_MISSING")) },
        secretRef,
        models: { triage: route, deep: route, translate: route },
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: "SECRET_MISSING" });
    expect(sentBodies(mock)).toEqual([]);
  });
});

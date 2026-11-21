import { JsonValueSchema } from "@ai-moves/contracts/primitives";
import { z } from "zod";

// One recorded or hand-written HTTP exchange. The layout and the rules for adding one are in
// packages/testing/fixtures/README.md.

export const FIXTURE_UPSTREAMS = [
  "_example",
  "hn",
  "github",
  "openrouter",
  "slack",
  "discord",
  "web",
] as const;
export const FixtureUpstreamSchema = z.enum(FIXTURE_UPSTREAMS);
export type FixtureUpstream = z.infer<typeof FixtureUpstreamSchema>;

export const FixtureScenarioSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const FixtureRequestSchema = z.strictObject({
  method: z.enum(["GET", "POST"]),
  url: z.url({ protocol: /^https$/ }),
});

export const FixtureResponseSchema = z.strictObject({
  status: z.int().min(100).max(599),
  headers: z.record(z.string().regex(/^[a-z0-9-]+$/), z.string()),
  // A JSON value is served as `application/json`; a string is served as is.
  body: JsonValueSchema,
});

export const RecordedExchangeSchema = z.strictObject({
  upstream: FixtureUpstreamSchema,
  scenario: FixtureScenarioSchema,
  // `recorded` came from the real service on `recorded_on`; `synthetic` was written by hand.
  origin: z.enum(["recorded", "synthetic"]),
  recorded_on: z.iso.date().nullable(),
  request: FixtureRequestSchema,
  response: FixtureResponseSchema,
});
export type RecordedExchange = z.infer<typeof RecordedExchangeSchema>;

export function fixturePath(upstream: FixtureUpstream, scenario: string): string {
  const validatedScenario = FixtureScenarioSchema.parse(scenario);
  return `${upstream}/${validatedScenario}.json`;
}

import { describe, expect, it } from "vitest";

import { AppConfigSchema } from "@ai-moves/contracts/config";

import { canonicalClusterUrl, clusterKey, normalizeClusterText } from "../src/clustering.ts";
import { scoreChangelog } from "../src/scoring/changelog.ts";

const config = AppConfigSchema.parse({
  models: {
    triage: { provider: "test", model: "triage", max_output_tokens: 1 },
    deep: { provider: "test", model: "deep", max_output_tokens: 1 },
    translate: { provider: "test", model: "translate", max_output_tokens: 1 },
  },
}).changelog;

describe("changelog scoring", () => {
  it("applies each frozen signal weight and clamps the result", () => {
    expect(
      scoreChangelog({
        signals: [
          { signal: "new_surface", evidence: ["API"] },
          { signal: "breaking", evidence: ["removed"] },
          { signal: "default_change", evidence: ["default"] },
          { signal: "long_notes", evidence: ["long"] },
          { signal: "semver_minor_or_major", evidence: ["2.0"] },
        ],
        config,
        computedAt: 4,
      }),
    ).toEqual({
      kind: "changelog",
      prior: 90,
      signals: [
        { signal: "new_surface", points: 30, evidence: ["API"] },
        { signal: "breaking", points: 25, evidence: ["removed"] },
        { signal: "default_change", points: 15, evidence: ["default"] },
        { signal: "long_notes", points: 10, evidence: ["long"] },
        { signal: "semver_minor_or_major", points: 10, evidence: ["2.0"] },
      ],
      computed_at: 4,
    });
    expect(
      scoreChangelog({
        signals: [
          { signal: "fix_or_deps_only", evidence: ["fix"] },
          { signal: "prerelease", evidence: ["beta"] },
        ],
        config,
        computedAt: 4,
      }).prior,
    ).toBe(0);
  });
});

describe("clustering", () => {
  it("normalizes whitespace, case, fragments, tracking parameters, and query order", () => {
    expect(normalizeClusterText("  Agent\tLaunch  ")).toBe("agent launch");
    expect(canonicalClusterUrl("HTTPS://Example.COM/path?z=2&utm_source=x#section")).toBe(
      "https://example.com/path?z=2",
    );
    const first = clusterKey({
      kind: "hn",
      externalKey: "hn-1",
      title: "  Agent Launch ",
      url: "https://example.com/path?b=2&a=1&utm_source=x",
    });
    const second = clusterKey({
      kind: "hn",
      externalKey: "hn-2",
      title: "agent   launch",
      url: "https://EXAMPLE.com/path?a=1&b=2#comments",
    });
    expect(first).toBe(second);
  });
});

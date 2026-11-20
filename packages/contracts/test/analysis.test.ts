import { readFileSync } from "node:fs";

import {
  ChangelogDeepAssessmentSchema,
  CitationSchema,
  HnDeepAssessmentSchema,
  TriageAssessmentSchema,
} from "@ai-moves/contracts/analysis";
import { CURRENT_JOB_VERSION } from "@ai-moves/contracts/messages";
import { CONTRACT_VERSION } from "@ai-moves/contracts/version";
import { describe, expect, it } from "vitest";

const citation = { locator: "comment:42", quote: "The default changed." };
const pass = { kind: "hn", decision: "pass", confidence: 0.75 };
const deep = {
  confidence: 0.8,
  why_now: "The default changed.",
  summary: "Review sandbox settings.",
  key_points: ["The new default is opt-in."],
  engineering_implications: ["Update CI flags."],
  caveats: ["Only applies to local execution."],
  citations: [citation],
};
const hn = { ...deep, kind: "hn", importance: 3 };
const changelog = { ...deep, kind: "changelog", impact: 2 };

describe("analysis contract", () => {
  it("adds the analysis subpath at 0.2.0 without changing queue versions", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(CONTRACT_VERSION).toBe("0.2.0");
    expect(manifest).toMatchObject({ version: CONTRACT_VERSION });
    expect(CURRENT_JOB_VERSION).toEqual({ poll: 1, triage: 1, deep: 1, deliver: 1 });
  });

  it("bounds citation text without rewriting it", () => {
    const atLimit = { locator: "x".repeat(2048), quote: "\n" + "x".repeat(999) };
    expect(CitationSchema.parse(atLimit)).toEqual(atLimit);
    for (const invalid of [
      { ...citation, locator: "" },
      { ...citation, locator: "x".repeat(2049) },
      { ...citation, quote: "x".repeat(1001) },
      { ...citation, quote: 42 },
      { ...citation, provider: "internal" },
    ]) {
      expect(CitationSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires a rejection reason only on the reject branch", () => {
    const reject = { ...pass, decision: "reject", rejection_reason: "Not timely" };
    expect(TriageAssessmentSchema.parse(pass)).toEqual(pass);
    expect(TriageAssessmentSchema.parse(reject)).toEqual(reject);
    for (const invalid of [
      { ...pass, decision: "reject" },
      { ...pass, rejection_reason: "Not timely" },
      { ...reject, rejection_reason: "" },
      { ...reject, rejection_reason: "x".repeat(501) },
      { ...reject, provider_note: "internal" },
      { ...pass, decision: "maybe" },
      { ...pass, kind: "release" },
      { ...pass, confidence: -0.01 },
      { ...pass, confidence: 1.01 },
      { ...pass, confidence: "0.75" },
    ]) {
      expect(TriageAssessmentSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps importance and impact distinct, integer, and in range", () => {
    for (const importance of [1, 5]) {
      expect(HnDeepAssessmentSchema.parse({ ...hn, importance }).importance).toBe(importance);
    }
    for (const impact of [0, 3]) {
      expect(ChangelogDeepAssessmentSchema.parse({ ...changelog, impact }).impact).toBe(impact);
    }
    for (const importance of [0, 6, 2.5]) {
      expect(HnDeepAssessmentSchema.safeParse({ ...hn, importance }).success).toBe(false);
    }
    for (const impact of [-1, 4, 1.5]) {
      expect(ChangelogDeepAssessmentSchema.safeParse({ ...changelog, impact }).success).toBe(false);
    }
    expect(HnDeepAssessmentSchema.safeParse(changelog).success).toBe(false);
    expect(ChangelogDeepAssessmentSchema.safeParse(hn).success).toBe(false);
    expect(HnDeepAssessmentSchema.safeParse({ ...hn, impact: 1 }).success).toBe(false);
    expect(ChangelogDeepAssessmentSchema.safeParse({ ...changelog, importance: 1 }).success).toBe(
      false,
    );
  });

  it("rejects oversized lists, malformed content, and extra fields in either deep assessment", () => {
    const tooManyPoints = Array<string>(9).fill("extra point");
    for (const invalidFields of [
      { confidence: 1.01 },
      { why_now: "" },
      { summary: "x".repeat(2001) },
      { key_points: tooManyPoints },
      { engineering_implications: tooManyPoints },
      { caveats: tooManyPoints },
      {
        citations: Array.from({ length: 9 }, (_, index) => ({
          ...citation,
          locator: `comment:${index}`,
        })),
      },
      { citations: [{ ...citation, snippet_id: "internal" }] },
      { provider_payload: {} },
    ]) {
      expect(HnDeepAssessmentSchema.safeParse({ ...hn, ...invalidFields }).success).toBe(false);
      expect(
        ChangelogDeepAssessmentSchema.safeParse({ ...changelog, ...invalidFields }).success,
      ).toBe(false);
    }
  });
});

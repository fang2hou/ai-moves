import * as analysis from "@ai-moves/contracts/analysis";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as alertDoc from "../src/alert-doc.ts";
import * as config from "../src/config.ts";
import * as entities from "../src/entities.ts";
import * as errors from "../src/errors.ts";
import * as logging from "../src/logging.ts";
import { JobSchema } from "../src/messages.ts";
import * as messages from "../src/messages.ts";
import * as llm from "../src/ports/llm.ts";
import * as notifier from "../src/ports/notifier.ts";
import * as runtime from "../src/ports/runtime.ts";
import * as sources from "../src/ports/sources.ts";
import * as storage from "../src/ports/storage.ts";
import * as primitives from "../src/primitives.ts";
import * as scoring from "../src/scoring.ts";
import * as states from "../src/states.ts";
import * as version from "../src/version.ts";
import { VALID_SAMPLES } from "./samples.ts";

const modules: readonly Record<string, unknown>[] = [
  alertDoc,
  analysis,
  config,
  entities,
  errors,
  logging,
  messages,
  primitives,
  scoring,
  states,
  version,
  llm,
  notifier,
  runtime,
  sources,
  storage,
];

function isSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

const exported = modules.flatMap((module) => Object.entries(module));

const schemas = exported.flatMap(([name, value]) =>
  name.endsWith("Schema") && isSchema(value) ? [{ name, schema: value }] : [],
);

function samplesFor(name: string, schema: z.ZodType): readonly unknown[] {
  if (schema instanceof z.ZodEnum) {
    const options: readonly unknown[] = schema.options;
    return options;
  }
  return VALID_SAMPLES[name] ?? [];
}

function overWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("contract schemas round-trip through JSON", () => {
  it("exports schemas to test", () => {
    expect(schemas.length).toBeGreaterThan(80);
  });

  it("has no sample for a schema that no longer exists", () => {
    const names = new Set(schemas.map((entry) => entry.name));
    expect(Object.keys(VALID_SAMPLES).filter((name) => !names.has(name))).toEqual([]);
  });

  describe.each(schemas)("$name", ({ name, schema }) => {
    const samples = samplesFor(name, schema);

    it("has at least one wire sample", () => {
      expect(samples.length).toBeGreaterThan(0);
    });

    it("parses every sample and survives serialise, deserialise, parse unchanged", () => {
      for (const sample of samples) {
        const parsed = schema.parse(overWire(sample));
        const reparsed = schema.parse(overWire(parsed));
        expect(reparsed).toEqual(parsed);
        expect(overWire(reparsed)).toEqual(overWire(parsed));
      }
    });
  });
});

describe("lossless boundaries", () => {
  const lossless = [
    "SourceSchema",
    "ItemSchema",
    "ItemSnapshotSchema",
    "ItemRevisionSchema",
    "AnalysisSchema",
    "AlertSchema",
    "DeliverySchema",
    "DestinationSchema",
    "BudgetLedgerEntrySchema",
    "AuditLogEntrySchema",
    "JobSchema",
    "TickEventSchema",
    "AlertDocSchema",
    "CitationSchema",
    "TriageAssessmentSchema",
    "HnDeepAssessmentSchema",
    "ChangelogDeepAssessmentSchema",
    "LogRecordSchema",
    "HnStorySchema",
    "HnCommentTreeSchema",
    "GitHubReleaseSchema",
    "WebDocumentSchema",
    "NotifyReceiptSchema",
  ];

  it.each(lossless)("%s returns exactly what was written", (name) => {
    const entry = schemas.find((candidate) => candidate.name === name);
    expect(entry).toBeDefined();
    for (const sample of VALID_SAMPLES[name] ?? []) {
      expect(entry?.schema.parse(overWire(sample))).toEqual(sample);
    }
  });

  it("drops unknown fields so an older consumer tolerates a newer producer", () => {
    const parsed = JobSchema.parse({
      v: 1,
      type: "triage",
      item_id: "item_1",
      trace_id: "trace_1",
      added_in_a_later_minor: true,
    });
    expect(parsed).toEqual({ v: 1, type: "triage", item_id: "item_1", trace_id: "trace_1" });
  });
});

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { AlertDocSchema } from "../src/alert-doc.ts";
import { AppConfigSchema } from "../src/config.ts";
import {
  BudgetScopeSchema,
  DeliverySchema,
  DestinationSchema,
  ItemSchema,
  SourceSchema,
} from "../src/entities.ts";
import { ErrorCodeSchema, ErrorSummarySchema } from "../src/errors.ts";
import { JobSchema } from "../src/messages.ts";
import {
  DayKeySchema,
  EntityIdSchema,
  HttpsUrlSchema,
  SecretRefSchema,
  TimeZoneSchema,
} from "../src/primitives.ts";
import { SAMPLE } from "./samples.ts";

interface Rejection {
  readonly name: string;
  readonly schema: z.ZodType;
  readonly input: unknown;
  readonly path: readonly (string | number)[];
}

const REJECTIONS: readonly Rejection[] = [
  {
    name: "a job with an unsupported version",
    schema: JobSchema,
    input: { ...SAMPLE.pollJob, v: 2 },
    path: ["v"],
  },
  {
    name: "a job with an unknown type",
    schema: JobSchema,
    input: { ...SAMPLE.pollJob, type: "purge" },
    path: ["type"],
  },
  {
    name: "a job that carries no trace id",
    schema: JobSchema,
    input: { v: 1, type: "deep", item_id: "item_1" },
    path: ["trace_id"],
  },
  {
    name: "an id with path characters",
    schema: EntityIdSchema,
    input: "../etc/passwd",
    path: [],
  },
  {
    name: "a source whose config is for another kind",
    schema: SourceSchema,
    input: { ...SAMPLE.hnSource, config_json: SAMPLE.githubSource.config_json },
    path: ["config_json", "kind"],
  },
  {
    name: "a source whose cursor is for another kind",
    schema: SourceSchema,
    input: { ...SAMPLE.hnSource, cursor_json: SAMPLE.githubSource.cursor_json },
    path: ["cursor_json", "kind"],
  },
  {
    name: "a poll interval that is not a multiple of five minutes",
    schema: SourceSchema,
    input: { ...SAMPLE.hnSource, poll_interval_sec: 450 },
    path: ["poll_interval_sec"],
  },
  {
    name: "an item in an unknown state",
    schema: ItemSchema,
    input: { ...SAMPLE.hnItem, state: "pushed" },
    path: ["state"],
  },
  {
    name: "an item with a non-http url",
    schema: ItemSchema,
    input: { ...SAMPLE.hnItem, url: "javascript:alert(1)" },
    path: ["url"],
  },
  {
    name: "a fractional timestamp",
    schema: ItemSchema,
    input: { ...SAMPLE.hnItem, last_seen_at: 1.5 },
    path: ["last_seen_at"],
  },
  {
    name: "a destination that stores a webhook url instead of a secret reference",
    schema: DestinationSchema,
    input: { ...SAMPLE.destination, secret_ref: "https://hooks.slack.com/services/T000/B000/XXXX" },
    path: ["secret_ref"],
  },
  {
    name: "a destination with an unsupported language",
    schema: DestinationSchema,
    input: { ...SAMPLE.destination, lang: "fr" },
    path: ["lang"],
  },
  {
    name: "a delivery whose error carries an unknown code",
    schema: DeliverySchema,
    input: { ...SAMPLE.delivery, last_error: { code: "NOPE", kind: "retryable", message: "x" } },
    path: ["last_error", "code"],
  },
  {
    name: "an alert doc whose detail link is not https",
    schema: AlertDocSchema,
    input: {
      ...SAMPLE.alertDoc,
      links: { ...SAMPLE.alertDoc.links, detail: "http://ai-moves.example.com/items/1" },
    },
    path: ["links", "detail"],
  },
  {
    name: "an alert doc of an unknown version",
    schema: AlertDocSchema,
    input: { ...SAMPLE.alertDoc, v: 2 },
    path: ["v"],
  },
  {
    name: "a config without models",
    schema: AppConfigSchema,
    input: {},
    path: ["models"],
  },
  {
    name: "a config with a misspelled kill switch",
    schema: AppConfigSchema,
    input: { models: SAMPLE.models, ai: { enabeld: false } },
    path: ["ai"],
  },
  {
    name: "a config with an unknown top-level key",
    schema: AppConfigSchema,
    input: { models: SAMPLE.models, experimental: true },
    path: [],
  },
  {
    name: "heat weights that do not sum to one",
    schema: AppConfigSchema,
    input: { models: SAMPLE.models, hn: { heat_weights: { vp: 0.9 } } },
    path: ["hn", "heat_weights"],
  },
  {
    name: "heat levels that are not ascending",
    schema: AppConfigSchema,
    input: { models: SAMPLE.models, hn: { heat_levels: { h1: 90, h2: 80 } } },
    path: ["hn", "heat_levels"],
  },
  {
    name: "a watchlist interval off the five minute grid",
    schema: AppConfigSchema,
    input: {
      models: SAMPLE.models,
      watchlist: [{ owner: "o", repo: "r", poll_interval_sec: 100 }],
    },
    path: ["watchlist", 0, "poll_interval_sec"],
  },
  { name: "an unknown error code", schema: ErrorCodeSchema, input: "TEAPOT", path: [] },
  { name: "an impossible calendar date", schema: DayKeySchema, input: "2026-02-29", path: [] },
  { name: "an unknown time zone", schema: TimeZoneSchema, input: "Mars/Olympus", path: [] },
  {
    name: "an error kind that does not match its code",
    schema: ErrorSummarySchema,
    input: { code: "NOT_FOUND", kind: "retryable", message: "missing" },
    path: ["kind"],
  },
  {
    name: "an inherited object key as error code",
    schema: ErrorCodeSchema,
    input: "toString",
    path: [],
  },
  { name: "a lowercase secret reference", schema: SecretRefSchema, input: "slack_hook", path: [] },
  {
    name: "an http url where https is required",
    schema: HttpsUrlSchema,
    input: "http://a.example",
    path: [],
  },
  { name: "an unknown budget scope", schema: BudgetScopeSchema, input: "ai:embed", path: [] },
];

describe("contract schemas reject invalid input", () => {
  it.each(REJECTIONS)("rejects $name", ({ schema, input, path }) => {
    const result = schema.safeParse(input);
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path) ?? [];
    expect(paths).toContainEqual(path);
  });
});

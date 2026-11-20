import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  acceptPreviousVersion,
  CURRENT_JOB_VERSION,
  JOB_SCHEMA_BY_QUEUE,
  JOB_TYPES,
  JobSchema,
  MAX_CONSUMER_BATCH_SIZE,
  MAX_JOB_BYTES,
  MAX_JOB_DELAY_SECONDS,
  QUEUE_BY_JOB_TYPE,
  QUEUE_NAMES,
  queueForJob,
} from "../src/messages.ts";
import { JOB_SAMPLES } from "./samples.ts";

const jobs = Object.values(JOB_SAMPLES).map((sample) => JobSchema.parse(sample));

describe("queue routing", () => {
  it("maps every job type to its own queue", () => {
    expect(Object.keys(QUEUE_BY_JOB_TYPE).toSorted()).toEqual(JOB_TYPES.toSorted());
    expect(Object.values(QUEUE_BY_JOB_TYPE).toSorted()).toEqual(QUEUE_NAMES.toSorted());
  });

  it.each(jobs)("routes a $type job and accepts it only on that queue", (job) => {
    const queue = queueForJob(job);
    expect(queue).toBe(`q-${job.type}`);
    for (const name of QUEUE_NAMES) {
      expect(JOB_SCHEMA_BY_QUEUE[name].safeParse(job).success).toBe(name === queue);
    }
  });

  it("declares a current version for every job type", () => {
    for (const job of jobs) {
      expect(CURRENT_JOB_VERSION[job.type]).toBe(job.v);
    }
  });
});

describe("portability limits", () => {
  it("keeps the limits of architecture 3.7", () => {
    expect(MAX_JOB_BYTES).toBe(1024);
    expect(MAX_JOB_DELAY_SECONDS).toBe(900);
    expect(MAX_CONSUMER_BATCH_SIZE).toBe(10);
  });

  it("stays under the size limit with the longest ids the schemas allow", () => {
    const longId = "x".repeat(64);
    const worstCases = [
      {
        v: 1,
        type: "poll",
        source_id: longId,
        tick_bucket: Number.MAX_SAFE_INTEGER,
        trace_id: longId,
      },
      { v: 1, type: "triage", item_id: longId, trace_id: longId },
      { v: 1, type: "deep", item_id: longId, trace_id: longId },
      { v: 1, type: "deliver", delivery_id: longId, trace_id: longId },
    ];
    for (const worstCase of worstCases) {
      const encoded = JSON.stringify(JobSchema.parse(worstCase));
      expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(MAX_JOB_BYTES);
    }
  });
});

describe("message versioning", () => {
  const V1 = z.object({ v: z.literal(1), type: z.literal("sample"), item: z.string() });
  const V2 = z.object({
    v: z.literal(2),
    type: z.literal("sample"),
    item_id: z.string(),
    trace_id: z.string(),
  });
  const Sample = acceptPreviousVersion(V2, V1, (old) => ({
    v: 2 as const,
    type: old.type,
    item_id: old.item,
    trace_id: "untraced",
  }));

  it("passes the current version through unchanged", () => {
    const current = { v: 2, type: "sample", item_id: "item_1", trace_id: "trace_1" };
    expect(Sample.parse(current)).toEqual(current);
  });

  it("upcasts the previous version to the current shape", () => {
    expect(Sample.parse({ v: 1, type: "sample", item: "item_1" })).toEqual({
      v: 2,
      type: "sample",
      item_id: "item_1",
      trace_id: "untraced",
    });
  });

  it("rejects versions older than the previous one and newer than the current one", () => {
    expect(Sample.safeParse({ v: 0, type: "sample", item: "item_1" }).success).toBe(false);
    expect(Sample.safeParse({ v: 3, type: "sample", item_id: "i", trace_id: "t" }).success).toBe(
      false,
    );
  });
});

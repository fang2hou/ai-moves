import { MAX_CONSUMER_BATCH_SIZE } from "@ai-moves/contracts/messages";
import { describe, expect, it } from "vitest";

import { decodeQueueBatch, decodeScheduledEvent } from "../src/messages.ts";

const poll = { v: 1, type: "poll", source_id: "src_1", tick_bucket: 42, trace_id: "trace_1" };

describe("decodeQueueBatch", () => {
  it("decodes a Worker-shaped batch", () => {
    expect(decodeQueueBatch({ queue: "q-poll", messages: [{ body: poll }] })).toEqual([poll]);
  });

  it("rejects malformed messages and wrong queue routing", () => {
    expect(() => decodeQueueBatch({ queue: "q-poll", messages: [{ body: {} }] })).toThrowError(
      expect.objectContaining({ code: "MESSAGE_INVALID" }),
    );
    expect(() =>
      decodeQueueBatch({
        queue: "q-triage",
        messages: [{ body: poll }],
      }),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
  });

  it("rejects malformed shapes and batches above the consumer limit", () => {
    expect(() => decodeQueueBatch({ queue: "q-poll", messages: null })).toThrowError(
      expect.objectContaining({ code: "MESSAGE_INVALID" }),
    );
    expect(() =>
      decodeQueueBatch({
        queue: "q-poll",
        messages: Array.from({ length: MAX_CONSUMER_BATCH_SIZE + 1 }, () => ({ body: poll })),
      }),
    ).toThrowError(expect.objectContaining({ code: "MESSAGE_INVALID" }));
  });
});

describe("decodeScheduledEvent", () => {
  it("maps the Worker controller shape into a tick event", () => {
    expect(decodeScheduledEvent({ scheduledTime: 1_795_000_000_000, cron: "*/5 * * * *" })).toEqual(
      {
        scheduled_time: 1_795_000_000_000,
        cron: "*/5 * * * *",
      },
    );
  });

  it("rejects malformed controller values", () => {
    expect(() => decodeScheduledEvent({ scheduledTime: "now", cron: "" })).toThrowError(
      expect.objectContaining({ code: "MESSAGE_INVALID" }),
    );
  });
});

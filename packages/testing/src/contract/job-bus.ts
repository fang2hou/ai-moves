import { type Job, MAX_JOB_DELAY_SECONDS, type QueueName } from "@ai-moves/contracts/messages";
import type { JobBus } from "@ai-moves/contracts/ports/runtime";
import { expect } from "vitest";

import { definePortContract } from "./define.ts";

export interface DeliveredJob {
  readonly queue: QueueName;
  // The message body exactly as a consumer receives it, before validation.
  readonly body: unknown;
  readonly delaySeconds: number;
}

export interface JobBusHarness {
  readonly bus: JobBus;
  // Everything accepted so far, across all queues, in no guaranteed order.
  readonly delivered: () => Promise<readonly DeliveredJob[]>;
}

const poll: Job = { v: 1, type: "poll", source_id: "src_1", tick_bucket: 42, trace_id: "trace_1" };
const triage: Job = { v: 1, type: "triage", item_id: "item_1", trace_id: "trace_1" };
const deep: Job = { v: 1, type: "deep", item_id: "item_1", trace_id: "trace_1" };
const deliver: Job = { v: 1, type: "deliver", delivery_id: "dl_1", trace_id: "trace_1" };

// Deliberately not a valid job: the contract checks that the bus validates at its boundary.
const malformed: unknown = { v: 1, type: "deep", trace_id: "trace_1" };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the case needs data that bypassed the type system
const invalidJob = malformed as Job;

function byQueue(jobs: readonly DeliveredJob[]): Record<string, unknown[]> {
  const grouped: Record<string, unknown[]> = {};
  for (const job of jobs) {
    (grouped[job.queue] ??= []).push(job.body);
  }
  return grouped;
}

export const jobBusContract = definePortContract<JobBusHarness>("JobBus", [
  {
    name: "routes each job type to its own queue",
    run: async ({ bus, delivered }) => {
      for (const job of [poll, triage, deep, deliver]) {
        await bus.enqueue(job);
      }
      expect(byQueue(await delivered())).toEqual({
        "q-poll": [poll],
        "q-triage": [triage],
        "q-deep": [deep],
        "q-deliver": [deliver],
      });
    },
  },
  {
    name: "delivers a body that survives a JSON round trip unchanged",
    run: async ({ bus, delivered }) => {
      await bus.enqueue(poll);
      const [message] = await delivered();
      expect(JSON.parse(JSON.stringify(message?.body))).toEqual(poll);
    },
  },
  {
    name: "sends without delay by default and passes an explicit delay through",
    run: async ({ bus, delivered }) => {
      await bus.enqueue(triage);
      await bus.enqueue(deep, { delaySeconds: MAX_JOB_DELAY_SECONDS });
      const delays = Object.fromEntries(
        (await delivered()).map((message) => [message.queue, message.delaySeconds]),
      );
      expect(delays).toEqual({ "q-triage": 0, "q-deep": MAX_JOB_DELAY_SECONDS });
    },
  },
  {
    name: "delivers every job of a batch",
    run: async ({ bus, delivered }) => {
      const second: Job = { ...triage, item_id: "item_2" };
      await bus.enqueueBatch([triage, second, deliver], { delaySeconds: 30 });
      const messages = await delivered();
      expect(messages.map((message) => message.delaySeconds)).toEqual([30, 30, 30]);
      const grouped = byQueue(messages);
      expect(Object.keys(grouped).toSorted()).toEqual(["q-deliver", "q-triage"]);
      expect(grouped["q-deliver"]).toEqual([deliver]);
      expect(grouped["q-triage"]).toHaveLength(2);
      expect(grouped["q-triage"]).toContainEqual(triage);
      expect(grouped["q-triage"]).toContainEqual(second);
    },
  },
  {
    name: "treats an empty batch as a no-op",
    run: async ({ bus, delivered }) => {
      await bus.enqueueBatch([]);
      expect(await delivered()).toEqual([]);
    },
  },
  {
    name: "keeps a duplicate enqueue as two messages, since delivery is at least once",
    run: async ({ bus, delivered }) => {
      await bus.enqueue(deliver);
      await bus.enqueue(deliver);
      expect(await delivered()).toHaveLength(2);
    },
  },
  {
    name: "rejects a job that does not match the message schema and enqueues nothing",
    run: async ({ bus, delivered }) => {
      await expect(bus.enqueue(invalidJob)).rejects.toMatchObject({
        code: "MESSAGE_INVALID",
        kind: "validation",
      });
      expect(await delivered()).toEqual([]);
    },
  },
  {
    name: "rejects a whole batch when one job is invalid",
    run: async ({ bus, delivered }) => {
      await expect(bus.enqueueBatch([triage, invalidJob])).rejects.toMatchObject({
        code: "MESSAGE_INVALID",
      });
      expect(await delivered()).toEqual([]);
    },
  },
  {
    name: "rejects a delay beyond the portable maximum",
    run: async ({ bus, delivered }) => {
      await expect(
        bus.enqueue(triage, { delaySeconds: MAX_JOB_DELAY_SECONDS + 1 }),
      ).rejects.toMatchObject({ code: "INPUT_INVALID", kind: "validation" });
      expect(await delivered()).toEqual([]);
    },
  },
  {
    name: "rejects a negative or fractional delay",
    run: async ({ bus, delivered }) => {
      await expect(bus.enqueue(triage, { delaySeconds: -1 })).rejects.toMatchObject({
        code: "INPUT_INVALID",
      });
      await expect(bus.enqueueBatch([triage], { delaySeconds: 1.5 })).rejects.toMatchObject({
        code: "INPUT_INVALID",
      });
      expect(await delivered()).toEqual([]);
    },
  },
]);

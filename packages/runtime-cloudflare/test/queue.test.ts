import type { Job, QueueName } from "@ai-moves/contracts/messages";
import type { DeliveredJob } from "@ai-moves/testing/contract/job-bus";
import { jobBusContract } from "@ai-moves/testing/contract/job-bus";
import { runPortContract } from "@ai-moves/testing/contract/define";
import { describe, expect, it, vi } from "vitest";

import { createCloudflareJobBus, type CloudflareQueueBinding } from "../src/queue.ts";
import { createRuntimeCloudflareHarness } from "./harness.ts";

interface QueueFailureControl {
  failAfter: number | undefined;
  successfulSends: number;
}

function createQueueBinding(
  queue: QueueName,
  delivered: DeliveredJob[],
  control: QueueFailureControl,
): CloudflareQueueBinding {
  const send = async (body: Job, options: { delaySeconds?: number } = {}) => {
    if (control.failAfter === control.successfulSends) {
      control.failAfter = undefined;
      throw new Error("synthetic queue failure");
    }
    delivered.push({ queue, body: structuredClone(body), delaySeconds: options.delaySeconds ?? 0 });
    control.successfulSends += 1;
    return {};
  };
  return {
    send,
    sendBatch: async (messages, options = {}) => {
      for (const message of messages) {
        await send(message.body, options);
      }
      return {};
    },
  };
}

runPortContract(jobBusContract, "Cloudflare queues", {
  create: () => {
    const delivered: DeliveredJob[] = [];
    const control: QueueFailureControl = { failAfter: undefined, successfulSends: 0 };
    const bindings = {
      "q-poll": createQueueBinding("q-poll", delivered, control),
      "q-triage": createQueueBinding("q-triage", delivered, control),
      "q-deep": createQueueBinding("q-deep", delivered, control),
      "q-deliver": createQueueBinding("q-deliver", delivered, control),
    };
    return {
      bus: createCloudflareJobBus(bindings),
      delivered: () => Promise.resolve(delivered),
      failSendAfter: (successfulSends: number) => {
        control.failAfter = successfulSends;
        control.successfulSends = 0;
      },
    };
  },
});

describe("Cloudflare queue adapter", () => {
  it("rejects missing bindings before sending", async () => {
    const bus = createCloudflareJobBus({});
    await expect(
      bus.enqueue({ v: 1, type: "poll", source_id: "src_1", tick_bucket: 1, trace_id: "t_1" }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", kind: "validation" });
  });

  it("classifies transport failures without wrapping a classified failure", async () => {
    const control: QueueFailureControl = { failAfter: 0, successfulSends: 0 };
    const binding = createQueueBinding("q-triage", [], control);
    const bus = createCloudflareJobBus({ "q-triage": binding });
    await expect(
      bus.enqueue({ v: 1, type: "triage", item_id: "item_1", trace_id: "t_1" }),
    ).rejects.toMatchObject({ code: "QUEUE_UNAVAILABLE", kind: "retryable" });
  });

  it("routes jobs through non-persistent Miniflare producers", async () => {
    const harness = await createRuntimeCloudflareHarness();
    try {
      const bus = createCloudflareJobBus(harness.queues);
      const jobs: Job[] = [
        { v: 1, type: "poll", source_id: "src_1", tick_bucket: 1, trace_id: "t_1" },
        { v: 1, type: "triage", item_id: "item_1", trace_id: "t_1" },
        { v: 1, type: "deep", item_id: "item_1", trace_id: "t_1" },
        { v: 1, type: "deliver", delivery_id: "delivery_1", trace_id: "t_1" },
      ];
      await bus.enqueueBatch(jobs);
      await vi.waitFor(
        async () => {
          const consumed = await Promise.all([
            harness.namespace.get("queue:q-poll", "text"),
            harness.namespace.get("queue:q-triage", "text"),
            harness.namespace.get("queue:q-deep", "text"),
            harness.namespace.get("queue:q-deliver", "text"),
          ]);
          expect(consumed).toEqual(jobs.map((job) => JSON.stringify([job])));
        },
        { timeout: 4000 },
      );
    } finally {
      await harness.miniflare.dispose();
    }
  });

  it("splits oversized Cloudflare batches only after validating all jobs", async () => {
    const sent: number[] = [];
    const binding: CloudflareQueueBinding = {
      send: () => Promise.resolve({}),
      sendBatch: async (messages) => {
        sent.push([...messages].length);
        return {};
      },
    };
    const bus = createCloudflareJobBus({ "q-triage": binding });
    const jobs = Array.from({ length: 101 }, (_, index): Job => ({
      v: 1,
      type: "triage",
      item_id: `item_${index}`,
      trace_id: "t_1",
    }));
    await bus.enqueueBatch(jobs);
    expect(sent).toEqual([100, 1]);
  });
});

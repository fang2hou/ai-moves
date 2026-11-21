import type { Job } from "@ai-moves/contracts/messages";
import type { JobBus } from "@ai-moves/contracts/ports/runtime";
import { describe, expect, it } from "vitest";

import { blobStoreContract, type BlobStoreHarness } from "../src/contract/blob-store.ts";
import { cacheContract } from "../src/contract/cache.ts";
import { definePortContract, type PortContract, runPortContract } from "../src/contract/define.ts";
import { type DeliveredJob, jobBusContract, type JobBusHarness } from "../src/contract/job-bus.ts";
import { createInMemoryBlobStore } from "../src/fakes/blob-store.ts";
import { createInMemoryCache } from "../src/fakes/cache.ts";
import { createFakeClock } from "../src/fakes/clock.ts";
import { createInMemoryJobBus } from "../src/fakes/job-bus.ts";

async function failingCases<Harness>(
  contract: PortContract<Harness>,
  create: () => Harness,
): Promise<string[]> {
  const failed: string[] = [];
  for (const contractCase of contract.cases) {
    try {
      await contractCase.run(create());
    } catch {
      failed.push(contractCase.name);
    }
  }
  return failed;
}

// A bus that skips validation and sends everything to one queue.
function createCarelessJobBus(): JobBusHarness {
  const delivered: DeliveredJob[] = [];
  const push = (job: Job, delaySeconds = 0): void => {
    delivered.push({ queue: "q-poll", body: job, delaySeconds });
  };
  const bus: JobBus = {
    enqueue: (job, options) => {
      push(job, options?.delaySeconds);
      return Promise.resolve();
    },
    enqueueBatch: (jobs, options) => {
      for (const job of jobs) {
        push(job, options?.delaySeconds);
      }
      return Promise.resolve();
    },
  };
  return { bus, delivered: () => Promise.resolve(delivered), failSendAfter: () => undefined };
}

// A store that keys by insertion order instead of by content.
function createCountingBlobStore(): BlobStoreHarness {
  const real = createInMemoryBlobStore();
  let counter = 0;
  return {
    store: {
      ...real,
      put: async (body, options) => {
        counter += 1;
        return { ...(await real.put(body, options)), key: `blob-${counter}` };
      },
    },
  };
}

describe("contract suites detect a wrong implementation", () => {
  it("passes every case for the correct fakes", async () => {
    expect(
      await failingCases(jobBusContract, () => {
        const bus = createInMemoryJobBus();
        return {
          bus,
          delivered: () => Promise.resolve(bus.delivered),
          failSendAfter: bus.failSendAfter,
        };
      }),
    ).toEqual([]);
    expect(
      await failingCases(blobStoreContract, () => ({ store: createInMemoryBlobStore() })),
    ).toEqual([]);
    expect(
      await failingCases(cacheContract, () => ({ cache: createInMemoryCache(createFakeClock()) })),
    ).toEqual([]);
  });

  it("fails the routing, validation, and delay cases for a careless job bus", async () => {
    expect(await failingCases(jobBusContract, createCarelessJobBus)).toEqual([
      "routes each job type to its own queue",
      "sends without delay by default and passes an explicit delay through",
      "delivers every job of a batch",
      "rejects a job that does not match the message schema and enqueues nothing",
      "rejects a whole batch when one job is invalid",
      "may partially deliver a valid batch and deliver duplicates on retry",
      "rejects a delay beyond the portable maximum",
      "rejects a negative or fractional delay",
    ]);
  });

  it("fails the addressing cases for a blob store that is not content addressed", async () => {
    const failed = await failingCases(blobStoreContract, createCountingBlobStore);
    expect(failed).toContain("addresses content by the SHA-256 of its bytes");
    expect(failed).toContain(
      "is idempotent: the same content yields the same reference, as text or as bytes",
    );
  });
});

describe("definePortContract", () => {
  it("keeps the port name and the cases in order", () => {
    const contract = definePortContract<number>("Sample", [
      { name: "first", run: () => undefined },
      { name: "second", run: () => undefined },
    ]);
    expect(contract.port).toBe("Sample");
    expect(contract.cases.map((contractCase) => contractCase.name)).toEqual(["first", "second"]);
  });
});

const lifecycle = { created: 0, disposed: 0, seen: [] as number[] };

runPortContract(
  definePortContract<number>("Lifecycle", [
    {
      name: "gets a fresh harness (first case)",
      run: (harness) => void lifecycle.seen.push(harness),
    },
    {
      name: "gets a fresh harness (second case)",
      run: (harness) => void lifecycle.seen.push(harness),
    },
  ]),
  "counter",
  {
    create: () => {
      lifecycle.created += 1;
      return lifecycle.created;
    },
    dispose: () => {
      lifecycle.disposed += 1;
    },
  },
);

describe("runPortContract", () => {
  it("has created and disposed one harness per case by the time the suite above finished", () => {
    expect(lifecycle).toEqual({ created: 2, disposed: 2, seen: [1, 2] });
  });
});

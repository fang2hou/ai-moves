import { runPortContract } from "../src/contract/define.ts";
import { jobBusContract } from "../src/contract/job-bus.ts";
import { createInMemoryJobBus } from "../src/fakes/job-bus.ts";

runPortContract(jobBusContract, "in-memory fake", {
  create: () => {
    const bus = createInMemoryJobBus();
    return {
      bus,
      delivered: () => Promise.resolve(bus.delivered),
      failSendAfter: bus.failSendAfter,
    };
  },
});

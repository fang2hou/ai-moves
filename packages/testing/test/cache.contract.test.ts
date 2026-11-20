import { cacheContract, cacheExpiryContract } from "../src/contract/cache.ts";
import { runPortContract } from "../src/contract/define.ts";
import { createInMemoryCache } from "../src/fakes/cache.ts";
import { createFakeClock } from "../src/fakes/clock.ts";

function createHarness() {
  const clock = createFakeClock();
  return {
    cache: createInMemoryCache(clock),
    advanceSeconds: (seconds: number) => clock.advance(seconds * 1000),
  };
}

runPortContract(cacheContract, "in-memory fake", { create: createHarness });
runPortContract(cacheExpiryContract, "in-memory fake", { create: createHarness });

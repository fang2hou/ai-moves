import { runPortContract } from "@ai-moves/testing/contract/define";
import {
  storageRepositoryContract,
  storedItemRowContract,
  type StorageRepositoryHarness,
  type StoredItemRowHarness,
} from "@ai-moves/testing/contract/storage";
import { createLocalD1 } from "@ai-moves/testing/test/d1";

import { createD1Storage } from "../src/d1.ts";
import { createMemoryStorage } from "../src/memory.ts";
import { applyStorageMigrations } from "../src/migrations.ts";

interface D1Harness extends StorageRepositoryHarness, StoredItemRowHarness {
  readonly dispose: () => Promise<void>;
}

runPortContract(storageRepositoryContract, "memory", {
  create: createMemoryStorage,
});

async function createD1Harness(): Promise<D1Harness> {
  const { database, dispose } = await createLocalD1(applyStorageMigrations);
  const repositories = createD1Storage(database);
  return {
    ...repositories,
    corruptItemScore: async (itemId) => {
      await database
        .prepare("UPDATE items SET score_json = ? WHERE id = ?")
        .bind('{"bad":true}', itemId)
        .run();
    },
    dispose,
  };
}

runPortContract(storageRepositoryContract, "D1 emulator", {
  create: async () => {
    const harness = await createD1Harness();
    return harness;
  },
  dispose: (harness) => harness.dispose(),
});

runPortContract(storedItemRowContract, "D1 emulator", {
  create: createD1Harness,
  dispose: (harness) => harness.dispose(),
});

import type { D1Database } from "@cloudflare/workers-types";
import { runPortContract } from "@ai-moves/testing/contract/define";
import {
  storageRepositoryContract,
  storedItemRowContract,
  type StorageRepositoryHarness,
  type StoredItemRowHarness,
} from "@ai-moves/testing/contract/storage";
import { Miniflare } from "miniflare";

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
  const worker = new Miniflare({
    host: "127.0.0.1",
    compatibilityDate: "2026-07-30",
    modules: true,
    d1Databases: { DB: "storage-test" },
    outboundService: () => {
      throw new Error("Unexpected outbound Worker request");
    },
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
  });
  const database: D1Database = await worker.getD1Database("DB");
  await applyStorageMigrations(database);
  const repositories = createD1Storage(database);
  return {
    ...repositories,
    corruptItemScore: async (itemId) => {
      await database
        .prepare("UPDATE items SET score_json = ? WHERE id = ?")
        .bind('{"bad":true}', itemId)
        .run();
    },
    dispose: () => worker.dispose(),
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

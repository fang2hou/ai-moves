import { blobStoreContract } from "../src/contract/blob-store.ts";
import { runPortContract } from "../src/contract/define.ts";
import { createInMemoryBlobStore } from "../src/fakes/blob-store.ts";

runPortContract(blobStoreContract, "in-memory fake", {
  create: () => ({ store: createInMemoryBlobStore() }),
});

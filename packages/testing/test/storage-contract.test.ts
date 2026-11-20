import type { Item, Source } from "@ai-moves/contracts/entities";
import type { ItemTransition } from "@ai-moves/contracts/ports/storage";
import { runPortContract } from "@ai-moves/testing/contract/define";
import { itemClaimContract, type ItemClaimHarness } from "@ai-moves/testing/contract/storage";
import { expect, it } from "vitest";

import { githubSource, observedItem } from "../src/contract/storage-fixtures.ts";

const source: Source = {
  ...githubSource,
  consecutive_failures: 0,
  last_success_at: null,
  status: "active",
};
const item: Item = {
  id: observedItem.id,
  source_id: observedItem.source_id,
  external_key: observedItem.external_key,
  kind: observedItem.kind,
  url: observedItem.url,
  title: observedItem.title,
  published_at: observedItem.published_at,
  content_hash: null,
  revision: 0,
  state: observedItem.state,
  state_updated_at: observedItem.observed_at,
  score_json: null,
  tier: null,
  cluster_id: null,
  attempts: 0,
  next_attempt_at: null,
  first_seen_at: observedItem.observed_at,
  last_seen_at: observedItem.observed_at,
};

function claimHarness(
  transition: (transition: ItemTransition) => Promise<boolean>,
  get: () => Promise<Item | null>,
): ItemClaimHarness {
  return {
    sources: { upsert: () => Promise.resolve({ created: true, value: source }) },
    items: {
      upsertObserved: () => Promise.resolve({ created: true, value: item }),
      transition,
      get,
    },
  };
}

runPortContract(itemClaimContract, "scripted single winner", {
  create: () => {
    let claimed: Item | null = null;
    return claimHarness(
      ({ at, to, patch }) => {
        if (claimed !== null) {
          return Promise.resolve(false);
        }
        claimed = { ...item, state: to, state_updated_at: at, attempts: patch?.attempts ?? 0 };
        return Promise.resolve(true);
      },
      () => Promise.resolve(claimed),
    );
  },
});

it("detects a backend that reports both competing item claims as successful", async () => {
  const harness = claimHarness(
    () => Promise.resolve(true),
    () => Promise.resolve(item),
  );
  const [claimCase] = itemClaimContract.cases;
  if (claimCase === undefined) {
    throw new Error("Missing item claim case");
  }

  await expect(Promise.resolve(claimCase.run(harness))).rejects.toThrow(/length of 1/);
});

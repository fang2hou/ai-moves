import type { Item } from "@ai-moves/contracts/entities";
import type { ItemPatch, ItemRepo, ObservedItem } from "@ai-moves/contracts/ports/storage";
import type { ItemState } from "@ai-moves/contracts/states";
import { clusterKey } from "@ai-moves/core/clustering";
import { itemKey } from "@ai-moves/core/idempotency";
import { isItemTransitionAllowed } from "@ai-moves/core/state/item";
import { observedSourceUrl } from "@ai-moves/kernel/public-links";

export interface ObservationState {
  readonly items: Pick<ItemRepo, "upsertObserved" | "transition">;
  readonly sampledAt: number;
  readonly beforeExpiry: () => boolean;
  readonly expiresAt: number;
  readonly now: () => number;
}

export async function observeItem(
  state: ObservationState,
  observation: Omit<ObservedItem, "id" | "state" | "observed_at">,
): Promise<Item> {
  const { value } = await state.items.upsertObserved({
    ...observation,
    url: observedSourceUrl(observation.url),
    id: itemKey(observation.external_key),
    observed_at: state.sampledAt,
    state: "discovered",
  });
  return value;
}

export async function recordScore(
  state: ObservationState,
  item: Item,
  to: ItemState,
  patch: ItemPatch,
): Promise<boolean> {
  if (
    !state.beforeExpiry() ||
    (item.score_json !== null && item.score_json.computed_at > state.sampledAt) ||
    (item.state !== to && !isItemTransitionAllowed(item.state, to))
  )
    return false;

  return state.items.transition({
    id: item.id,
    from: item.state,
    to,
    expected: item,
    // An observation is not a new work claim or a wake-up acknowledgement.
    at: item.state === to ? item.state_updated_at : state.now(),
    patch: {
      ...patch,
      cluster_id:
        item.cluster_id ??
        clusterKey({
          kind: item.kind,
          externalKey: item.external_key,
          title: item.title,
          url: item.url,
        }),
      ...(item.state !== to && to === "candidate" ? { next_attempt_at: null } : {}),
    },
  });
}

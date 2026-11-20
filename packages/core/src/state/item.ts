import {
  isItemStateTerminal,
  isItemTransitionAllowed,
  type ItemState,
} from "@ai-moves/contracts/states";

export type ItemTransitionGuard =
  | { readonly allowed: true; readonly from: ItemState; readonly to: ItemState }
  | { readonly allowed: false; readonly from: ItemState; readonly to: ItemState };

export function guardItemTransition(from: ItemState, to: ItemState): ItemTransitionGuard {
  return isItemTransitionAllowed(from, to)
    ? { allowed: true, from, to }
    : { allowed: false, from, to };
}

export { isItemStateTerminal, isItemTransitionAllowed };

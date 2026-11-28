import {
  isDeliveryStateTerminal,
  isDeliveryTransitionAllowed,
  type DeliveryState,
} from "@ai-news-tracker/contracts/states";

export type DeliveryTransitionGuard =
  | { readonly allowed: true; readonly from: DeliveryState; readonly to: DeliveryState }
  | { readonly allowed: false; readonly from: DeliveryState; readonly to: DeliveryState };

export function guardDeliveryTransition(
  from: DeliveryState,
  to: DeliveryState,
): DeliveryTransitionGuard {
  return isDeliveryTransitionAllowed(from, to)
    ? { allowed: true, from, to }
    : { allowed: false, from, to };
}

export { isDeliveryStateTerminal, isDeliveryTransitionAllowed };

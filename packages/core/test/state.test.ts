import { describe, expect, it } from "vitest";

import {
  DELIVERY_STATES,
  DELIVERY_STATE_TRANSITIONS,
  ITEM_STATES,
  ITEM_STATE_TRANSITIONS,
  type DeliveryState,
  type ItemState,
} from "@ai-moves/contracts/states";

import { guardDeliveryTransition } from "../src/state/delivery.ts";
import { guardItemTransition } from "../src/state/item.ts";

const itemEdges: Readonly<Record<ItemState, readonly ItemState[]>> = ITEM_STATE_TRANSITIONS;
const deliveryEdges: Readonly<Record<DeliveryState, readonly DeliveryState[]>> =
  DELIVERY_STATE_TRANSITIONS;

describe("state transition guards", () => {
  it("accepts and rejects every item-state pair from the frozen table", () => {
    for (const from of ITEM_STATES) {
      for (const to of ITEM_STATES) {
        expect(guardItemTransition(from, to)).toEqual({
          allowed: itemEdges[from].includes(to),
          from,
          to,
        });
      }
    }
  });

  it("accepts and rejects every delivery-state pair from the frozen table", () => {
    for (const from of DELIVERY_STATES) {
      for (const to of DELIVERY_STATES) {
        expect(guardDeliveryTransition(from, to)).toEqual({
          allowed: deliveryEdges[from].includes(to),
          from,
          to,
        });
      }
    }
  });

  it("never permits retry after an ambiguous delivery outcome", () => {
    expect(guardDeliveryTransition("unknown", "sending").allowed).toBe(false);
    expect(guardDeliveryTransition("sent", "sending").allowed).toBe(false);
  });
});

import { z } from "zod";

import type { AlertDoc } from "../alert-doc.ts";
import type { Destination } from "../entities.ts";
import type { ContentHash } from "../primitives.ts";
import type { DestinationChannel } from "../states.ts";

export const NotifyReceiptSchema = z.object({
  // Discord returns a message id; a Slack incoming webhook does not.
  provider_message_id: z.string().min(1).max(128).nullable(),
});
export type NotifyReceipt = z.infer<typeof NotifyReceiptSchema>;

// One send attempt, never retried internally. Failures are classified by kind: 429, a received
// 5xx, and connection failure before the request was written are UPSTREAM_RATE_LIMITED or
// UPSTREAM_UNAVAILABLE; other 4xx is UPSTREAM_REJECTED; a timeout after the body was written is
// OUTCOME_UNKNOWN (architecture 4.4).
export interface Notifier {
  readonly channel: DestinationChannel;
  send(
    destination: Destination,
    doc: AlertDoc,
    idempotencyKey: ContentHash,
  ): Promise<NotifyReceipt>;
}

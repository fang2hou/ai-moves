import type { Delivery } from "@ai-moves/contracts/entities";
import type { DeliveryRepo } from "@ai-moves/contracts/ports/storage";
import { AppError, summarizeDurableError } from "@ai-moves/kernel/errors/app-error";

export async function recoverExpiredSend(
  deliveries: Pick<DeliveryRepo, "transition">,
  claimed: Delivery,
  at: number,
  leaseMs: number,
): Promise<boolean> {
  if (claimed.state !== "sending" || at - claimed.state_updated_at < leaseMs) return false;
  return deliveries.transition({
    id: claimed.id,
    from: "sending",
    to: "unknown",
    at,
    expected: { state_updated_at: claimed.state_updated_at, attempts: claimed.attempts },
    patch: {
      last_error: summarizeDurableError(new AppError("OUTCOME_UNKNOWN")),
      next_attempt_at: null,
    },
  });
}

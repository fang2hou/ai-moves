import type { Delivery } from "@ai-moves/contracts/entities";
import type { NotifyReceipt } from "@ai-moves/contracts/ports/notifier";
import type { Clock } from "@ai-moves/contracts/ports/runtime";
import type { DeliveryRepo } from "@ai-moves/contracts/ports/storage";
import { stableKey } from "@ai-moves/core/idempotency";
import { AppError, isAppError, summarizeError } from "@ai-moves/kernel/errors/app-error";

export interface AttemptOptions {
  readonly maxAttempts: number;
  readonly backoffSeconds: readonly number[];
}

export async function finishSend(
  deliveries: Pick<DeliveryRepo, "transition">,
  clock: Clock,
  claimed: Delivery,
  send: () => Promise<NotifyReceipt>,
  options: AttemptOptions,
): Promise<boolean> {
  const expected = { state_updated_at: claimed.state_updated_at, attempts: claimed.attempts };
  let receipt: NotifyReceipt;
  try {
    receipt = await send();
  } catch (error) {
    const failure = isAppError(error) ? error : new AppError("OUTCOME_UNKNOWN");
    const at = clock.now();
    const retry = failure.kind === "retryable" && claimed.attempts < options.maxAttempts;
    const finalError =
      failure.kind === "retryable" && !retry ? new AppError("ATTEMPTS_EXHAUSTED") : failure;
    const seconds =
      options.backoffSeconds[Math.min(claimed.attempts - 1, options.backoffSeconds.length - 1)];
    const jitter =
      retry && seconds !== undefined
        ? Number.parseInt(
            stableKey("delivery-backoff", claimed.id, String(claimed.attempts)).slice(0, 8),
            16,
          ) / 0xffff_ffff
        : 0;
    return deliveries.transition({
      id: claimed.id,
      from: "sending",
      to:
        failure.kind === "ambiguous" ? "unknown" : retry ? "failed_retryable" : "failed_permanent",
      at,
      expected,
      patch: {
        last_error: summarizeError(finalError),
        next_attempt_at:
          retry && seconds !== undefined
            ? at + Math.round(seconds * 1000 * (0.8 + 0.4 * jitter))
            : null,
      },
    });
  }
  return deliveries.transition({
    id: claimed.id,
    from: "sending",
    to: "sent",
    at: clock.now(),
    expected,
    patch: { provider_message_id: receipt.provider_message_id, next_attempt_at: null },
  });
}

import { AlertDocSchema, type AlertDoc } from "@ai-moves/contracts/alert-doc";
import type { Alert, Delivery } from "@ai-moves/contracts/entities";
import type {
  ClaimVersion,
  DeliverySendRequest,
  FeedQuery,
  WorkLease,
} from "@ai-moves/contracts/ports/storage";
import type { EntityId, EpochMs } from "@ai-moves/contracts/primitives";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { AppError } from "@ai-moves/kernel/errors/app-error";

export function compareId(left: EntityId, right: EntityId): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function beforeCursor(at: EpochMs, id: EntityId, before: FeedQuery["before"]): boolean {
  return before === undefined || at < before.at || (at === before.at && id < before.id);
}

export function matchesVersion(row: ClaimVersion, expected: ClaimVersion | undefined): boolean {
  return (
    expected === undefined ||
    (row.state_updated_at === expected.state_updated_at && row.attempts === expected.attempts)
  );
}

export function validateLease(lease: WorkLease): void {
  if (lease.expiresAt <= lease.now) throw new AppError("INPUT_INVALID");
}

export function sendIntervalCutoff(request: DeliverySendRequest): EpochMs | null {
  const { at, minIntervalMinutes, maxUpdatesPerItem } = request;
  if (
    !Number.isSafeInteger(at) ||
    at < 0 ||
    !Number.isSafeInteger(minIntervalMinutes) ||
    minIntervalMinutes < 0 ||
    !Number.isSafeInteger(maxUpdatesPerItem) ||
    maxUpdatesPerItem < 0
  ) {
    throw new AppError("INPUT_INVALID");
  }
  return minIntervalMinutes === 0 ? null : Math.max(-1, at - minIntervalMinutes * 60_000);
}

export function validateAlertDocuments(
  alert: Alert,
  deliveries: readonly Delivery[],
  documents: readonly AlertDoc[],
): readonly AlertDoc[] {
  const parsed = new Map<AlertDoc["lang"], AlertDoc>();
  for (const document of documents) {
    const doc = parseBoundary(AlertDocSchema, document, "INPUT_INVALID");
    if (
      doc.alert_id !== alert.id ||
      doc.kind !== alert.kind ||
      doc.tier !== alert.tier ||
      parsed.has(doc.lang)
    ) {
      throw new AppError("STATE_CONFLICT");
    }
    parsed.set(doc.lang, doc);
  }
  for (const delivery of deliveries) {
    if (
      (delivery.state === "pending" || delivery.state === "failed_retryable") &&
      !parsed.has(delivery.lang)
    ) {
      throw new AppError("STATE_CONFLICT");
    }
  }
  return [...parsed.values()];
}

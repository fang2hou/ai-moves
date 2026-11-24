import { AlertDocSchema, type AlertDoc } from "@ai-moves/contracts/alert-doc";
import type { Alert, Delivery, Destination } from "@ai-moves/contracts/entities";
import type { IdGen, JobBus } from "@ai-moves/contracts/ports/runtime";
import type { AlertRepo, DeliveryRepo } from "@ai-moves/contracts/ports/storage";
import type { ItemKind } from "@ai-moves/contracts/states";
import { deliveryKey } from "@ai-moves/core/idempotency";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { AppError } from "@ai-moves/kernel/errors/app-error";

export interface FinalizationPorts {
  readonly alerts: Pick<AlertRepo, "insertWithDeliveries" | "replaceDocuments">;
  readonly deliveries: Pick<DeliveryRepo, "listByAlert">;
  readonly jobs: Pick<JobBus, "enqueueBatch">;
}

export function planDeliveries(input: {
  readonly alert: Alert;
  readonly documents: readonly AlertDoc[];
  readonly destinations: readonly Destination[];
  readonly itemKind: ItemKind;
  readonly now: number;
  readonly expiresAt: number;
  readonly forceDryRun: boolean;
  readonly ids: IdGen;
}): readonly Delivery[] {
  const languages = new Set(
    input.documents.map((document) => {
      const doc = parseBoundary(AlertDocSchema, document, "INPUT_INVALID");
      if (
        doc.alert_id !== input.alert.id ||
        doc.kind !== input.alert.kind ||
        doc.tier !== input.alert.tier ||
        doc.item_kind !== input.itemKind
      ) {
        throw new AppError("INPUT_INVALID");
      }
      return doc.lang;
    }),
  );
  if (input.alert.decision !== "send" || input.expiresAt <= input.now) return [];
  const seen = new Set<string>();
  const deliveries: Delivery[] = [];
  for (const destination of input.destinations) {
    if (
      seen.has(destination.id) ||
      !destination.enabled ||
      !destination.source_filters[input.itemKind] ||
      destination.min_tier > input.alert.tier ||
      !languages.has(destination.lang)
    ) {
      continue;
    }
    seen.add(destination.id);
    deliveries.push({
      id: input.ids.next(),
      alert_id: input.alert.id,
      destination_id: destination.id,
      idempotency_key: deliveryKey(input.alert.id, destination.id),
      state: "pending",
      state_updated_at: input.now,
      attempts: 0,
      provider_message_id: null,
      last_error: null,
      next_attempt_at: null,
      expires_at: input.expiresAt,
      lang: destination.lang,
      dry_run: input.forceDryRun || destination.dry_run,
      suppressed_reason: null,
      created_at: input.now,
    });
  }
  return deliveries;
}

export async function finalizeAlert(
  ports: FinalizationPorts,
  input: {
    readonly alert: Alert;
    readonly deliveries: readonly Delivery[];
    readonly documents: readonly AlertDoc[];
    readonly traceId: string;
  },
): Promise<Alert> {
  const result = await ports.alerts.insertWithDeliveries(
    input.alert,
    input.deliveries,
    input.documents,
  );
  if (
    !result.created &&
    result.value.analysis_id === input.alert.analysis_id &&
    input.documents.length > 0
  ) {
    await ports.alerts.replaceDocuments(
      result.value.id,
      input.documents.map((doc) => ({ ...doc, alert_id: result.value.id })),
    );
  }
  const deliveries = await ports.deliveries.listByAlert(result.value.id);
  const jobs = deliveries
    .filter((delivery) => delivery.state === "pending")
    .map((delivery) => ({
      v: 1 as const,
      type: "deliver" as const,
      delivery_id: delivery.id,
      trace_id: input.traceId,
    }));
  for (let index = 0; index < jobs.length; index += 10) {
    await ports.jobs.enqueueBatch(jobs.slice(index, index + 10));
  }
  return result.value;
}

import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import type { Alert, Delivery } from "@ai-moves/contracts/entities";
import type { JobBus } from "@ai-moves/contracts/ports/runtime";
import type { AlertRepo, DeliveryRepo } from "@ai-moves/contracts/ports/storage";

export interface FinalizationPorts {
  readonly alerts: Pick<AlertRepo, "insertWithDeliveries">;
  readonly deliveries: Pick<DeliveryRepo, "listByAlert">;
  readonly jobs: Pick<JobBus, "enqueueBatch">;
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

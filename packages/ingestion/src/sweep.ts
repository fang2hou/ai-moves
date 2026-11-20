import type { AppConfig } from "@ai-moves/contracts/config";
import type { Job } from "@ai-moves/contracts/messages";
import type { Clock, IdGen, JobBus, Telemetry } from "@ai-moves/contracts/ports/runtime";
import type { DeliveryRepo, ItemRepo, ItemSnapshotRepo } from "@ai-moves/contracts/ports/storage";
import { AppError, summarizeError } from "@ai-moves/kernel/errors/app-error";

import { POLL_BUCKET_MS, publishJobs } from "./jobs.ts";

export interface SweepPorts {
  readonly items: Pick<ItemRepo, "listStale" | "transition">;
  readonly deliveries: Pick<DeliveryRepo, "listDue" | "listStale" | "transition">;
  readonly snapshots: Pick<ItemSnapshotRepo, "deleteBefore">;
  readonly jobs: JobBus;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly telemetry: Pick<Telemetry, "count">;
}

export interface SweepOptions {
  readonly config: Pick<AppConfig, "leases" | "hn">;
  readonly limit: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export async function sweepStaleWork(ports: SweepPorts, options: SweepOptions): Promise<void> {
  const now = ports.clock.now();
  const { config, limit } = options;
  const { telemetry } = ports;
  const traceId = ports.ids.next();
  const jobs: Job[] = [];
  const expiredSending = await ports.deliveries.listStale({
    states: ["sending"],
    updatedBefore: now - config.leases.deliver_minutes * MINUTE_MS,
    limit,
  });
  telemetry.count("pipeline.sweep.selected", expiredSending.length, { group: "sending" });
  for (const row of expiredSending) {
    const recovered = await ports.deliveries.transition({
      id: row.id,
      from: "sending",
      to: "unknown",
      at: now,
      expected: row,
      patch: {
        next_attempt_at: null,
        last_error: summarizeError(
          new AppError("OUTCOME_UNKNOWN", {
            message: "Sending lease expired without a recorded outcome",
          }),
        ),
      },
    });
    telemetry.count("pipeline.sweep.recovery", 1, {
      from: "sending",
      outcome: recovered ? "unknown" : "fenced",
    });
  }

  const readyItems = await ports.items.listStale({
    states: ["candidate", "triaged_pass", "analyzed"],
    updatedBefore: now - POLL_BUCKET_MS,
    readyAt: now,
    limit,
  });
  telemetry.count("pipeline.sweep.selected", readyItems.length, { group: "ready_items" });
  for (const item of readyItems) {
    jobs.push({
      v: 1,
      type: item.state === "candidate" ? "triage" : "deep",
      item_id: item.id,
      trace_id: traceId,
    });
  }

  for (const lease of [
    { from: "triaging", to: "candidate", minutes: config.leases.triage_minutes, job: "triage" },
    { from: "analyzing", to: "triaged_pass", minutes: config.leases.deep_minutes, job: "deep" },
  ] as const) {
    const expired = await ports.items.listStale({
      states: [lease.from],
      updatedBefore: now - lease.minutes * MINUTE_MS,
      readyAt: now,
      limit,
    });
    telemetry.count("pipeline.sweep.selected", expired.length, { group: lease.from });
    for (const item of expired) {
      // Only the consumer can check for completed analysis before enforcing exhaustion.
      const recovered = await ports.items.transition({
        id: item.id,
        from: lease.from,
        to: lease.to,
        at: now,
        expected: item,
      });
      telemetry.count("pipeline.sweep.recovery", 1, {
        from: lease.from,
        outcome: recovered ? lease.to : "fenced",
      });
      if (recovered) {
        jobs.push({ v: 1, type: lease.job, item_id: item.id, trace_id: traceId });
      }
    }
  }

  const dueDeliveries = await ports.deliveries.listDue(now, limit);
  telemetry.count("pipeline.sweep.selected", dueDeliveries.length, { group: "due_deliveries" });
  for (const delivery of dueDeliveries) {
    jobs.push({ v: 1, type: "deliver", delivery_id: delivery.id, trace_id: traceId });
  }

  const snapshotCutoff = now - config.hn.snapshot_retention_hours * HOUR_MS;
  if (snapshotCutoff > 0) {
    const deleted = await ports.snapshots.deleteBefore(snapshotCutoff, limit);
    telemetry.count("pipeline.sweep.snapshots_deleted", deleted);
  }
  await publishJobs(ports.jobs, jobs);
  telemetry.count("pipeline.sweep.published", jobs.length);
}

import type { AppConfig } from "@ai-moves/contracts/config";
import type { Job } from "@ai-moves/contracts/messages";
import type { Clock, IdGen, JobBus, Telemetry } from "@ai-moves/contracts/ports/runtime";
import type { DeliveryRepo, ItemRepo, ItemSnapshotRepo } from "@ai-moves/contracts/ports/storage";
import { AppError, summarizeDurableError, toAppError } from "@ai-moves/kernel/errors/app-error";

import { POLL_BUCKET_MS, publishJobs } from "./jobs.ts";

export interface SweepPorts {
  readonly items: Pick<ItemRepo, "listStale" | "transition">;
  readonly deliveries: Pick<DeliveryRepo, "listDue" | "listStale" | "transition">;
  readonly snapshots: Pick<ItemSnapshotRepo, "deleteBefore">;
  readonly jobs: JobBus;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly telemetry: Pick<Telemetry, "count" | "log">;
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
  const expiredSending = await selectGroup(ports, "sending", () =>
    ports.deliveries.listStale({
      states: ["sending"],
      updatedBefore: now - config.leases.deliver_minutes * MINUTE_MS,
      limit,
    }),
  );
  for (const row of expiredSending) {
    const recovered = await ports.deliveries.transition({
      id: row.id,
      from: "sending",
      to: "unknown",
      at: now,
      expected: row,
      patch: {
        next_attempt_at: null,
        last_error: summarizeDurableError(new AppError("OUTCOME_UNKNOWN")),
      },
    });
    telemetry.count("pipeline.sweep.recovery", 1, {
      from: "sending",
      outcome: recovered ? "unknown" : "fenced",
    });
  }

  const readyItems = await selectGroup(ports, "ready_items", () =>
    ports.items.listStale({
      states: ["candidate", "triaged_pass", "analyzed"],
      updatedBefore: now - POLL_BUCKET_MS,
      readyAt: now,
      limit,
    }),
  );
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
    const expired = await selectGroup(ports, lease.from, () =>
      ports.items.listStale({
        states: [lease.from],
        updatedBefore: now - lease.minutes * MINUTE_MS,
        readyAt: now,
        limit,
      }),
    );
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

  const dueDeliveries = await selectGroup(ports, "due_deliveries", () =>
    ports.deliveries.listDue(now, limit),
  );
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

// One malformed row makes a list read reject as a whole, so each group reads on its own and a
// rejected read costs only that group for this sweep.
async function selectGroup<T>(
  ports: SweepPorts,
  group: string,
  read: () => Promise<readonly T[]>,
): Promise<readonly T[]> {
  const { telemetry } = ports;
  try {
    const rows = await read();
    telemetry.count("pipeline.sweep.selected", rows.length, { group });
    return rows;
  } catch (cause) {
    // Shaped like `pipeline.sweep_failed`, which the worker logs when the whole sweep rejects.
    telemetry.log({
      ts: ports.clock.now(),
      level: "error",
      event: "pipeline.sweep_read_failed",
      component: "pipeline",
      stage: "sweep",
      err: summarizeDurableError(toAppError(cause)),
      attrs: { group },
    });
    telemetry.count("pipeline.sweep.read_failed", 1, { group });
    return [];
  }
}

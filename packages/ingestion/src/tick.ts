import type { TickEvent } from "@ai-moves/contracts/messages";
import type { Clock, IdGen, JobBus, Telemetry } from "@ai-moves/contracts/ports/runtime";
import type { SourceRepo } from "@ai-moves/contracts/ports/storage";

import { POLL_BUCKET_MS, publishJobs } from "./jobs.ts";

export interface TickPorts {
  readonly sources: Pick<SourceRepo, "scheduleDue" | "listReadyPolls">;
  readonly jobs: JobBus;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly telemetry: Pick<Telemetry, "count">;
}

export async function dispatchDueSources(
  ports: TickPorts,
  event: TickEvent,
  limit: number,
): Promise<void> {
  const now = ports.clock.now();
  await ports.sources.scheduleDue(now, Math.floor(event.scheduled_time / POLL_BUCKET_MS), limit);
  const ready = await ports.sources.listReadyPolls(now, limit);
  ports.telemetry.count("pipeline.dispatch.ready", ready.length);
  if (ready.length === 0) return;
  const traceId = ports.ids.next();
  await publishJobs(
    ports.jobs,
    ready.map((work) => ({ v: 1, type: "poll", ...work, trace_id: traceId })),
  );
  ports.telemetry.count("pipeline.dispatch.published", ready.length);
}

import { POLL_INTERVAL_STEP_SEC } from "@ai-moves/contracts/entities";
import { MAX_CONSUMER_BATCH_SIZE, type Job } from "@ai-moves/contracts/messages";
import type { JobBus } from "@ai-moves/contracts/ports/runtime";

export const POLL_BUCKET_MS = POLL_INTERVAL_STEP_SEC * 1000;

export async function publishJobs(bus: JobBus, jobs: readonly Job[]): Promise<void> {
  for (let offset = 0; offset < jobs.length; offset += MAX_CONSUMER_BATCH_SIZE) {
    await bus.enqueueBatch(jobs.slice(offset, offset + MAX_CONSUMER_BATCH_SIZE));
  }
}

import {
  type Job,
  JobSchema,
  MAX_JOB_BYTES,
  MAX_JOB_DELAY_SECONDS,
  queueForJob,
  type QueueName,
} from "@ai-moves/contracts/messages";
import type { EnqueueOptions, JobBus } from "@ai-moves/contracts/ports/runtime";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import type { DeliveredJob } from "../contract/job-bus.ts";

export interface InMemoryJobBus extends JobBus {
  readonly delivered: readonly DeliveredJob[];
  // Validated jobs waiting on one queue, in arrival order.
  jobs(queue: QueueName): Job[];
  // Removes and returns everything on one queue, the way a consumer batch would.
  drain(queue: QueueName): Job[];
  clear(): void;
}

function resolveDelay(options: EnqueueOptions | undefined): number {
  const delaySeconds = options?.delaySeconds ?? 0;
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_JOB_DELAY_SECONDS) {
    throw new AppError("INPUT_INVALID", {
      message: `INPUT_INVALID: delaySeconds must be an integer from 0 to ${MAX_JOB_DELAY_SECONDS}`,
      context: { delay_seconds: delaySeconds },
    });
  }
  return delaySeconds;
}

function toMessage(job: Job, delaySeconds: number): DeliveredJob {
  const validated = parseBoundary(JobSchema, job, "MESSAGE_INVALID");
  const encoded = JSON.stringify(validated);
  if (new TextEncoder().encode(encoded).byteLength > MAX_JOB_BYTES) {
    throw new AppError("MESSAGE_INVALID", {
      message: `MESSAGE_INVALID: job exceeds ${MAX_JOB_BYTES} bytes`,
    });
  }
  // Stored in wire form, so a consumer under test reads exactly what a real queue would hand it.
  const body: unknown = JSON.parse(encoded);
  return { queue: queueForJob(validated), body, delaySeconds };
}

export function createInMemoryJobBus(): InMemoryJobBus {
  const delivered: DeliveredJob[] = [];

  const accept = (jobs: readonly Job[], options: EnqueueOptions | undefined): void => {
    const delaySeconds = resolveDelay(options);
    // Validate everything before accepting anything, so a rejected batch leaves no trace.
    delivered.push(...jobs.map((job) => toMessage(job, delaySeconds)));
  };

  const jobsOn = (queue: QueueName): Job[] =>
    delivered
      .filter((message) => message.queue === queue)
      .map((message) => parseBoundary(JobSchema, message.body, "MESSAGE_INVALID"));

  return {
    delivered,
    enqueue: async (job, options) => {
      await Promise.resolve();
      accept([job], options);
    },
    enqueueBatch: async (jobs, options) => {
      await Promise.resolve();
      accept(jobs, options);
    },
    jobs: jobsOn,
    drain: (queue) => {
      const drained = jobsOn(queue);
      const remaining = delivered.filter((message) => message.queue !== queue);
      delivered.length = 0;
      delivered.push(...remaining);
      return drained;
    },
    clear: () => {
      delivered.length = 0;
    },
  };
}

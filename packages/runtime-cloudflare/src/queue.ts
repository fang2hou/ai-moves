import {
  type Job,
  JobSchema,
  MAX_JOB_BYTES,
  MAX_JOB_DELAY_SECONDS,
  QUEUE_BY_JOB_TYPE,
  type QueueName,
} from "@ai-moves/contracts/messages";
import type { EnqueueOptions, JobBus } from "@ai-moves/contracts/ports/runtime";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { missingBinding, platformFailure } from "./failures.ts";

export interface CloudflareQueueBinding {
  send(body: Job, options?: { contentType?: "json"; delaySeconds?: number }): Promise<unknown>;
  sendBatch(
    messages: Iterable<{ body: Job; contentType?: "json" }>,
    options?: { delaySeconds?: number },
  ): Promise<unknown>;
}

export type CloudflareQueueBindings = Partial<Record<QueueName, CloudflareQueueBinding>>;

interface ValidatedJob {
  readonly body: Job;
  readonly queue: QueueName;
}

const MAX_CLOUDFLARE_SEND_BATCH_SIZE = 100;

function resolveDelay(options: EnqueueOptions | undefined): number {
  const delaySeconds = options?.delaySeconds ?? 0;
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_JOB_DELAY_SECONDS) {
    throw new AppError("INPUT_INVALID", {
      message: "INPUT_INVALID: delaySeconds must be an integer in the portable queue range",
      context: { delay_seconds: delaySeconds, maximum: MAX_JOB_DELAY_SECONDS },
    });
  }
  return delaySeconds;
}

function validateJob(input: Job): ValidatedJob {
  const body = parseBoundary(JobSchema, input, "MESSAGE_INVALID");
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_JOB_BYTES) {
    throw new AppError("MESSAGE_INVALID", {
      message: "MESSAGE_INVALID: encoded job exceeds the portable queue limit",
      context: { maximum_bytes: MAX_JOB_BYTES },
    });
  }
  return { body, queue: QUEUE_BY_JOB_TYPE[body.type] };
}

function requireQueue(bindings: CloudflareQueueBindings, name: QueueName): CloudflareQueueBinding {
  const binding = bindings[name];
  if (binding === undefined) {
    throw missingBinding("CONFIG_INVALID", name);
  }
  return binding;
}

export function createCloudflareJobBus(bindings: CloudflareQueueBindings): JobBus {
  return {
    enqueue: async (job, options) => {
      const delaySeconds = resolveDelay(options);
      const validated = validateJob(job);
      const queue = requireQueue(bindings, validated.queue);
      try {
        await queue.send(validated.body, { delaySeconds, contentType: "json" });
      } catch (error) {
        throw platformFailure("QUEUE_UNAVAILABLE", "queue send", error);
      }
    },
    enqueueBatch: async (jobs, options) => {
      const delaySeconds = resolveDelay(options);
      const validated = jobs.map(validateJob);
      if (validated.length === 0) {
        return;
      }

      const queues = new Map<QueueName, { binding: CloudflareQueueBinding; jobs: Job[] }>();
      for (const job of validated) {
        const existing = queues.get(job.queue);
        if (existing !== undefined) {
          existing.jobs.push(job.body);
        } else {
          queues.set(job.queue, { binding: requireQueue(bindings, job.queue), jobs: [job.body] });
        }
      }

      for (const { binding, jobs: routedJobs } of queues.values()) {
        for (let start = 0; start < routedJobs.length; start += MAX_CLOUDFLARE_SEND_BATCH_SIZE) {
          const messages = routedJobs
            .slice(start, start + MAX_CLOUDFLARE_SEND_BATCH_SIZE)
            .map((body) => ({ body, contentType: "json" as const }));
          try {
            await binding.sendBatch(messages, { delaySeconds });
          } catch (error) {
            throw platformFailure("QUEUE_UNAVAILABLE", "queue batch send", error);
          }
        }
      }
    },
  };
}

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

import type { AwsJsonClient, AwsJsonResult } from "./json-client.ts";

// Queue URLs by the logical queue name the job contract uses.
export type SqsQueueUrls = Readonly<Record<QueueName, string>>;

const MAX_SQS_SEND_BATCH_SIZE = 10;

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

function encodeJob(input: Job): { readonly queue: QueueName; readonly body: string } {
  const job = parseBoundary(JobSchema, input, "MESSAGE_INVALID");
  const body = JSON.stringify(job);
  if (new TextEncoder().encode(body).byteLength > MAX_JOB_BYTES) {
    throw new AppError("MESSAGE_INVALID", {
      message: "MESSAGE_INVALID: encoded job exceeds the portable queue limit",
      context: { maximum_bytes: MAX_JOB_BYTES },
    });
  }
  return { queue: QUEUE_BY_JOB_TYPE[job.type], body };
}

function requireAccepted(result: AwsJsonResult, operation: string): AwsJsonResult & { ok: true } {
  if (!result.ok) {
    throw new AppError("QUEUE_UNAVAILABLE", {
      message: `QUEUE_UNAVAILABLE: SQS ${operation} was refused`,
      context: { operation, status: result.status, type: result.type },
    });
  }
  return result;
}

// Every job is validated before anything is sent. A batch is sent per queue in chunks of ten;
// a failure after an earlier chunk was accepted means a retry can deliver those jobs again,
// which the at-least-once contract already allows.
export function createSqsJobBus(sqs: AwsJsonClient, queueUrls: SqsQueueUrls): JobBus {
  return {
    async enqueue(job, options) {
      const delaySeconds = resolveDelay(options);
      const { queue, body } = encodeJob(job);
      requireAccepted(
        await sqs.call("SendMessage", {
          QueueUrl: queueUrls[queue],
          MessageBody: body,
          DelaySeconds: delaySeconds,
        }),
        "SendMessage",
      );
    },
    async enqueueBatch(jobs, options) {
      const delaySeconds = resolveDelay(options);
      const routed = new Map<QueueName, string[]>();
      for (const job of jobs) {
        const { queue, body } = encodeJob(job);
        routed.set(queue, [...(routed.get(queue) ?? []), body]);
      }
      for (const [queue, bodies] of routed) {
        for (let start = 0; start < bodies.length; start += MAX_SQS_SEND_BATCH_SIZE) {
          const entries = bodies
            .slice(start, start + MAX_SQS_SEND_BATCH_SIZE)
            .map((body, index) => ({
              Id: String(index),
              MessageBody: body,
              DelaySeconds: delaySeconds,
            }));
          const result = requireAccepted(
            await sqs.call("SendMessageBatch", { QueueUrl: queueUrls[queue], Entries: entries }),
            "SendMessageBatch",
          );
          const failed = result.body["Failed"];
          if (Array.isArray(failed) && failed.length > 0) {
            throw new AppError("QUEUE_UNAVAILABLE", {
              message: "QUEUE_UNAVAILABLE: SQS rejected part of a batch",
              context: { queue, failed: failed.length },
            });
          }
        }
      }
    },
  };
}

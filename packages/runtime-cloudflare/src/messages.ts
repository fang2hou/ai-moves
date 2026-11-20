import {
  type Job,
  JobSchema,
  MAX_CONSUMER_BATCH_SIZE,
  queueForJob,
  QueueNameSchema,
  TickEventSchema,
  type TickEvent,
} from "@ai-moves/contracts/messages";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { AppError } from "@ai-moves/kernel/errors/app-error";

export interface WorkerQueueMessage {
  readonly body: unknown;
}

export interface WorkerQueueBatch {
  readonly queue: unknown;
  readonly messages: readonly WorkerQueueMessage[];
}

export interface WorkerScheduledController {
  readonly scheduledTime: unknown;
  readonly cron: unknown;
}

function requireBatch(input: unknown): WorkerQueueBatch {
  if (
    typeof input !== "object" ||
    input === null ||
    !("queue" in input) ||
    !("messages" in input) ||
    !Array.isArray(input.messages)
  ) {
    throw new AppError("MESSAGE_INVALID", {
      message: "MESSAGE_INVALID: queue batch does not match the Worker shape",
    });
  }
  return { queue: input.queue, messages: input.messages };
}

export function decodeQueueBatch(input: unknown): readonly Job[] {
  const batch = requireBatch(input);
  const queue = parseBoundary(QueueNameSchema, batch.queue, "MESSAGE_INVALID", {
    boundary: "queue.batch",
  });
  if (batch.messages.length > MAX_CONSUMER_BATCH_SIZE) {
    throw new AppError("MESSAGE_INVALID", {
      message: "MESSAGE_INVALID: queue batch exceeds the consumer limit",
      context: { batch_size: batch.messages.length, maximum: MAX_CONSUMER_BATCH_SIZE },
    });
  }
  return batch.messages.map((message, index) => {
    if (typeof message !== "object" || message === null || !("body" in message)) {
      throw new AppError("MESSAGE_INVALID", {
        message: `MESSAGE_INVALID: queue message ${index} does not match the Worker shape`,
        context: { index },
      });
    }
    const job = parseBoundary(JobSchema, message.body, "MESSAGE_INVALID", {
      boundary: "queue.message",
      index,
      queue,
    });
    if (queueForJob(job) !== queue) {
      throw new AppError("MESSAGE_INVALID", {
        message: `MESSAGE_INVALID: queue message ${index} is routed to the wrong queue`,
        context: { expected_queue: queueForJob(job), index, queue },
      });
    }
    return job;
  });
}

export function decodeScheduledEvent(input: WorkerScheduledController): TickEvent {
  return parseBoundary(
    TickEventSchema,
    { scheduled_time: input.scheduledTime, cron: input.cron },
    "MESSAGE_INVALID",
    { boundary: "scheduled" },
  );
}

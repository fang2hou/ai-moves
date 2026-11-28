import {
  type Job,
  JobSchema,
  MAX_CONSUMER_BATCH_SIZE,
  queueForJob,
  type QueueName,
  TickEventSchema,
  type TickEvent,
} from "@ai-news-tracker/contracts/messages";
import { parseBoundary } from "@ai-news-tracker/kernel/boundary";
import { AppError } from "@ai-news-tracker/kernel/errors/app-error";

// The parts of the Lambda event shapes this package reads; everything else is ignored.
export interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
  readonly eventSourceARN: string;
  readonly attempts: number | undefined;
  readonly sentAt: number | undefined;
}

export interface SqsBatchResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// Validates the batch envelope. Each record's body is decoded separately, so one bad message
// fails only itself.
export function readSqsEvent(input: unknown): readonly SqsRecord[] {
  const records = field(input, "Records");
  if (!Array.isArray(records) || records.length > MAX_CONSUMER_BATCH_SIZE) {
    throw new AppError("MESSAGE_INVALID", {
      message: "MESSAGE_INVALID: event is not an SQS batch within the consumer limit",
    });
  }
  return records.map((record: unknown, index) => {
    const messageId = field(record, "messageId");
    const body = field(record, "body");
    const eventSourceARN = field(record, "eventSourceARN");
    if (
      typeof messageId !== "string" ||
      typeof body !== "string" ||
      typeof eventSourceARN !== "string"
    ) {
      throw new AppError("MESSAGE_INVALID", {
        message: `MESSAGE_INVALID: SQS record ${index} does not match the Lambda shape`,
        context: { index },
      });
    }
    const attributes = field(record, "attributes");
    return {
      messageId,
      body,
      eventSourceARN,
      attempts: positiveInteger(field(attributes, "ApproximateReceiveCount")),
      sentAt: positiveInteger(field(attributes, "SentTimestamp")),
    };
  });
}

export function decodeSqsJob(raw: unknown, queue: QueueName): Job {
  let body: unknown;
  try {
    if (typeof raw !== "string") throw new AppError("MESSAGE_INVALID");
    body = JSON.parse(raw);
  } catch (cause) {
    throw new AppError("MESSAGE_INVALID", {
      message: "MESSAGE_INVALID: SQS message body is not JSON",
      cause,
    });
  }
  const job = parseBoundary(JobSchema, body, "MESSAGE_INVALID", {
    boundary: "queue.message",
    queue,
  });
  if (queueForJob(job) !== queue) {
    throw new AppError("MESSAGE_INVALID", {
      message: "MESSAGE_INVALID: SQS message is routed to the wrong queue",
      context: { expected_queue: queueForJob(job), queue },
    });
  }
  return job;
}

// An EventBridge scheduled event carries the scheduled time as an ISO timestamp.
export function decodeScheduledEvent(input: unknown, label: string): TickEvent {
  const time = field(input, "time");
  return parseBoundary(
    TickEventSchema,
    { scheduled_time: typeof time === "string" ? Date.parse(time) : time, cron: label },
    "MESSAGE_INVALID",
    { boundary: "scheduled" },
  );
}

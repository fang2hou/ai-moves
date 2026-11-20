import { z } from "zod";

import { EntityIdSchema, NonNegativeIntSchema, TraceIdSchema } from "./primitives.ts";

export const QUEUE_NAMES = ["q-poll", "q-triage", "q-deep", "q-deliver"] as const;
export const QueueNameSchema = z.enum(QUEUE_NAMES);
export type QueueName = z.infer<typeof QueueNameSchema>;

// Portability limits of architecture 3.7: the tighter of Cloudflare Queues and SQS.
export const MAX_JOB_BYTES = 1024;
export const MAX_JOB_DELAY_SECONDS = 900;
export const MAX_CONSUMER_BATCH_SIZE = 10;

export const PollJobV1Schema = z.object({
  v: z.literal(1),
  type: z.literal("poll"),
  source_id: EntityIdSchema,
  tick_bucket: NonNegativeIntSchema,
  trace_id: TraceIdSchema,
});

export const TriageJobV1Schema = z.object({
  v: z.literal(1),
  type: z.literal("triage"),
  item_id: EntityIdSchema,
  trace_id: TraceIdSchema,
});

export const DeepJobV1Schema = z.object({
  v: z.literal(1),
  type: z.literal("deep"),
  item_id: EntityIdSchema,
  trace_id: TraceIdSchema,
});

export const DeliverJobV1Schema = z.object({
  v: z.literal(1),
  type: z.literal("deliver"),
  delivery_id: EntityIdSchema,
  trace_id: TraceIdSchema,
});

// Builds a schema that accepts the current version and the one before it, upcasting old messages,
// so the two deployment units can be released in either order (architecture 3.4). When a job gains
// a v2: keep its V1 schema, add the V2 schema, and export
// `acceptPreviousVersion(V2Schema, V1Schema, upcast)` as the job schema.
export function acceptPreviousVersion<Current, Previous>(
  current: z.ZodType<Current>,
  previous: z.ZodType<Previous>,
  upcast: (message: Previous) => Current,
): z.ZodType<Current> {
  return z.union([current, previous.transform(upcast)]);
}

export const PollJobSchema = PollJobV1Schema;
export const TriageJobSchema = TriageJobV1Schema;
export const DeepJobSchema = DeepJobV1Schema;
export const DeliverJobSchema = DeliverJobV1Schema;

export type PollJob = z.infer<typeof PollJobSchema>;
export type TriageJob = z.infer<typeof TriageJobSchema>;
export type DeepJob = z.infer<typeof DeepJobSchema>;
export type DeliverJob = z.infer<typeof DeliverJobSchema>;

export const JobSchema = z.discriminatedUnion("type", [
  PollJobSchema,
  TriageJobSchema,
  DeepJobSchema,
  DeliverJobSchema,
]);
export type Job = z.infer<typeof JobSchema>;
export type JobType = Job["type"];

export const JOB_TYPES = [
  "poll",
  "triage",
  "deep",
  "deliver",
] as const satisfies readonly JobType[];

export const CURRENT_JOB_VERSION = {
  poll: 1,
  triage: 1,
  deep: 1,
  deliver: 1,
} as const satisfies { [Type in JobType]: Extract<Job, { type: Type }>["v"] };

export const QUEUE_BY_JOB_TYPE = {
  poll: "q-poll",
  triage: "q-triage",
  deep: "q-deep",
  deliver: "q-deliver",
} as const satisfies Record<JobType, QueueName>;

export const JOB_SCHEMA_BY_QUEUE = {
  "q-poll": PollJobSchema,
  "q-triage": TriageJobSchema,
  "q-deep": DeepJobSchema,
  "q-deliver": DeliverJobSchema,
} as const satisfies Record<QueueName, z.ZodType<Job>>;

export function queueForJob(job: Job): QueueName {
  return QUEUE_BY_JOB_TYPE[job.type];
}

export const TickEventSchema = z.object({
  scheduled_time: NonNegativeIntSchema,
  cron: z.string().min(1).max(64),
});
export type TickEvent = z.infer<typeof TickEventSchema>;

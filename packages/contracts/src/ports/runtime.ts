import type { LogRecord } from "../logging.ts";
import type { Job, TickEvent } from "../messages.ts";
import type { EpochMs, SecretRef } from "../primitives.ts";

export interface Clock {
  now(): EpochMs;
}

export interface IdGen {
  next(): string;
}

export interface EnqueueOptions {
  // At most MAX_JOB_DELAY_SECONDS; longer waits use `next_attempt_at` and the sweeper.
  readonly delaySeconds?: number;
}

// Delivery is at least once and unordered, so every consumer must be idempotent. The queue is
// derived from the job type; a job larger than MAX_JOB_BYTES is rejected with MESSAGE_INVALID.
export interface JobBus {
  enqueue(job: Job, options?: EnqueueOptions): Promise<void>;
  enqueueBatch(jobs: readonly Job[], options?: EnqueueOptions): Promise<void>;
}

export interface SecretProvider {
  // Rejects with SECRET_MISSING when the reference is not bound.
  get(ref: SecretRef): Promise<string>;
}

export interface Telemetry {
  log(record: LogRecord): void;
  count(metric: string, value: number, dimensions?: Readonly<Record<string, string>>): void;
}

// Inbound port: the platform calls this on every cron tick.
export type TickHandler = (event: TickEvent) => Promise<void>;

// The shape of the platform `fetch` that adapters receive by injection, so tests can substitute a
// mock upstream. Only adapter packages may be handed the real one (architecture 3.3).
export type HttpFetch = (request: Request) => Promise<Response>;

import type { D1Database } from "@cloudflare/workers-types";

import type { RuntimeEnv } from "@ai-moves/contracts/config";
import type { QueueName } from "@ai-moves/contracts/messages";
import type { HttpFetch, SecretProvider } from "@ai-moves/contracts/ports/runtime";
import { loadRuntimeEnv } from "@ai-moves/kernel/config";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import type { R2BlobBinding } from "@ai-moves/runtime-cloudflare/blob-store";
import type { CloudflareQueueBinding } from "@ai-moves/runtime-cloudflare/queue";
import { createCloudflareSecretProvider } from "@ai-moves/runtime-cloudflare/secrets";

import { parseDeskOrigin, rejectWhitespace } from "./deployment-settings.ts";

interface PinnedEgress {
  resolve(hostname: string): Promise<readonly string[]>;
  fetchPinned(request: Request, address: string): Promise<Response>;
}

export interface PipelineBindings {
  readonly DB: D1Database;
  readonly BLOBS: R2BlobBinding;
  readonly POLL_QUEUE: CloudflareQueueBinding;
  readonly TRIAGE_QUEUE: CloudflareQueueBinding;
  readonly DEEP_QUEUE: CloudflareQueueBinding;
  readonly DELIVER_QUEUE: CloudflareQueueBinding;
  readonly PROVIDER_HTTP: { fetch: HttpFetch };
  readonly PINNED_WEB: PinnedEgress;
  readonly DESK_ORIGIN: string;
  readonly ENVIRONMENT: string;
  readonly LOG_LEVEL?: string;
  readonly GITHUB_TOKEN: string;
  readonly OPENROUTER_API_KEY: string;
  readonly HYPER_API_KEY?: string;
  readonly DISCORD_WEBHOOK_URL?: string;
  readonly TRIGGER_TOKEN?: string;
}

const queueBindings = {
  "q-poll": "POLL_QUEUE",
  "q-triage": "TRIAGE_QUEUE",
  "q-deep": "DEEP_QUEUE",
  "q-deliver": "DELIVER_QUEUE",
} as const satisfies Record<QueueName, keyof PipelineBindings>;

interface BoundPipeline {
  readonly settings: RuntimeEnv;
  readonly deskOrigin: string;
  readonly queues: Readonly<Record<QueueName, CloudflareQueueBinding>>;
  readonly providerSecrets: SecretProvider;
}

export function readBindings(env: PipelineBindings): BoundPipeline {
  const settings = loadRuntimeEnv(env);
  const deskOrigin = parseDeskOrigin(env.DESK_ORIGIN);
  requireMethods("DB", env.DB, ["prepare", "batch"]);
  requireMethods("BLOBS", env.BLOBS, ["get", "head", "put"]);
  requireMethods("PROVIDER_HTTP", env.PROVIDER_HTTP, ["fetch"]);
  requireMethods("PINNED_WEB", env.PINNED_WEB, ["resolve", "fetchPinned"]);
  for (const binding of Object.values(queueBindings)) {
    requireMethods(binding, env[binding], ["send", "sendBatch"]);
  }
  const providerBindings = {
    get GITHUB_TOKEN() {
      return env.GITHUB_TOKEN;
    },
    get OPENROUTER_API_KEY() {
      return env.OPENROUTER_API_KEY;
    },
    get HYPER_API_KEY() {
      return env.HYPER_API_KEY;
    },
    get DISCORD_WEBHOOK_URL() {
      return env.DISCORD_WEBHOOK_URL;
    },
  };
  const providerSecrets = createCloudflareSecretProvider(providerBindings);
  return {
    settings,
    deskOrigin,
    queues: {
      "q-poll": env[queueBindings["q-poll"]],
      "q-triage": env[queueBindings["q-triage"]],
      "q-deep": env[queueBindings["q-deep"]],
      "q-deliver": env[queueBindings["q-deliver"]],
    },
    providerSecrets: rejectWhitespace(providerSecrets),
  };
}

function requireMethods(name: string, binding: unknown, methods: readonly string[]): void {
  if (
    typeof binding !== "object" ||
    binding === null ||
    methods.some((method) => typeof Reflect.get(binding, method) !== "function")
  ) {
    throw new AppError("CONFIG_INVALID", { message: `Invalid Worker binding: ${name}` });
  }
}

import type { D1Database } from "@cloudflare/workers-types";

import type { RuntimeEnv } from "@ai-moves/contracts/config";
import type { QueueName } from "@ai-moves/contracts/messages";
import type { HttpFetch, SecretProvider } from "@ai-moves/contracts/ports/runtime";
import { SecretRefSchema } from "@ai-moves/contracts/primitives";
import { loadRuntimeEnv } from "@ai-moves/kernel/config";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import type { R2BlobBinding } from "@ai-moves/runtime-cloudflare/blob-store";
import type { CloudflareQueueBinding } from "@ai-moves/runtime-cloudflare/queue";
import { createCloudflareSecretProvider } from "@ai-moves/runtime-cloudflare/secrets";

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
  readonly DESTINATION_WEBHOOKS?: string;
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
  readonly destinationSecrets: SecretProvider;
}

export function readBindings(env: PipelineBindings): BoundPipeline {
  const settings = loadRuntimeEnv(env);
  const origin = typeof env.DESK_ORIGIN === "string" ? URL.parse(env.DESK_ORIGIN) : null;
  if (
    origin === null ||
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.href.length > 1800
  ) {
    throw new AppError("CONFIG_INVALID", { message: "DESK_ORIGIN must be an HTTPS origin" });
  }
  requireMethods("DB", env.DB, ["prepare", "batch"]);
  requireMethods("BLOBS", env.BLOBS, ["get", "head", "put"]);
  requireMethods("PROVIDER_HTTP", env.PROVIDER_HTTP, ["fetch"]);
  requireMethods("PINNED_WEB", env.PINNED_WEB, ["resolve", "fetchPinned"]);
  for (const binding of Object.values(queueBindings)) {
    requireMethods(binding, env[binding], ["send", "sendBatch"]);
  }
  const providerBindings = {
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  };
  return {
    settings,
    deskOrigin: origin.origin,
    queues: {
      "q-poll": env[queueBindings["q-poll"]],
      "q-triage": env[queueBindings["q-triage"]],
      "q-deep": env[queueBindings["q-deep"]],
      "q-deliver": env[queueBindings["q-deliver"]],
    },
    providerSecrets: createCloudflareSecretProvider(providerBindings),
    destinationSecrets: createCloudflareSecretProvider(
      readDestinationWebhooks(env, providerBindings),
    ),
  };
}

function readDestinationWebhooks(env: PipelineBindings, providerBindings: object): object {
  const raw = env.DESTINATION_WEBHOOKS;
  if (raw === undefined) return {};
  if (typeof raw !== "string") throw new AppError("CONFIG_INVALID");
  let webhooks: unknown;
  try {
    webhooks = JSON.parse(raw);
  } catch {
    throw new AppError("CONFIG_INVALID");
  }
  if (typeof webhooks !== "object" || webhooks === null || Array.isArray(webhooks)) {
    throw new AppError("CONFIG_INVALID");
  }
  for (const [ref, webhook] of Object.entries(webhooks)) {
    if (
      !SecretRefSchema.safeParse(ref).success ||
      ref === "DESTINATION_WEBHOOKS" ||
      Object.hasOwn(providerBindings, ref) ||
      Object.hasOwn(env, ref) ||
      typeof webhook !== "string" ||
      webhook.length === 0
    ) {
      throw new AppError("CONFIG_INVALID");
    }
  }
  return webhooks;
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

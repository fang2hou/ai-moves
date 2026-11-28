import type { D1Database } from "@cloudflare/workers-types";

import type { RuntimeEnv } from "@ai-news-tracker/contracts/config";
import type { QueueName } from "@ai-news-tracker/contracts/messages";
import type { HttpFetch, SecretProvider } from "@ai-news-tracker/contracts/ports/runtime";
import { SubmitterSchema, type Submitter } from "@ai-news-tracker/contracts/scoring";
import { loadRuntimeEnv } from "@ai-news-tracker/kernel/config";
import { AppError } from "@ai-news-tracker/kernel/errors/app-error";
import type { R2BlobBinding } from "@ai-news-tracker/runtime-cloudflare/blob-store";
import type { CloudflareQueueBinding } from "@ai-news-tracker/runtime-cloudflare/queue";
import { createCloudflareSecretProvider } from "@ai-news-tracker/runtime-cloudflare/secrets";

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
  // The MCP endpoint is off unless MCP_TOKEN is set; MCP_SUBMITTER_NAME then names who its
  // submissions are published under.
  readonly MCP_TOKEN?: string;
  readonly MCP_SUBMITTER_NAME?: string;
}

const MIN_MCP_TOKEN_LENGTH = 16;

export interface McpAccess {
  readonly token: string;
  readonly submitter: Submitter;
}

// Null while the endpoint is disabled. A token without a valid submitter name is a deployment
// mistake and fails loudly rather than publishing under a blank name.
export function readMcpAccess(
  env: Pick<PipelineBindings, "MCP_TOKEN" | "MCP_SUBMITTER_NAME">,
): McpAccess | null {
  const token = env.MCP_TOKEN;
  if (typeof token !== "string" || token.length < MIN_MCP_TOKEN_LENGTH) return null;
  const submitter = SubmitterSchema.safeParse({ name: env.MCP_SUBMITTER_NAME, email: null });
  if (!submitter.success) {
    throw new AppError("CONFIG_INVALID", {
      message: "MCP_SUBMITTER_NAME is required when MCP_TOKEN is set",
    });
  }
  return { token, submitter: submitter.data };
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

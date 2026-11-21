import { AppConfigSchema, type AppConfig } from "@ai-moves/contracts/config";
import type { Destination } from "@ai-moves/contracts/entities";
import type { LogRecord } from "@ai-moves/contracts/logging";
import { type Job, type QueueName } from "@ai-moves/contracts/messages";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import type { CloudflareQueueBinding } from "@ai-moves/runtime-cloudflare/queue";
import { createD1Storage, type D1StorageRepositories } from "@ai-moves/storage/d1";
import { applyStorageMigrations } from "@ai-moves/storage/migrations";
import { createFakeClock, type FakeClock } from "@ai-moves/testing/fakes/clock";
import { createSequentialIdGen } from "@ai-moves/testing/fakes/id-gen";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Miniflare } from "miniflare";

import type { PipelineBindings } from "../src/bindings.ts";
import { createPipelineWorker, type PipelineWorker } from "../src/worker.ts";

export const START = Date.UTC(2026, 6, 15, 12);
export const TICK_MS = 300_000;
export const SOURCE = "release-source";
export const RELEASE = "https://github.com/example/acme/releases/tag/v1.2.3";
export const TITLE = "Acme CLI v1.2.3";
export const EVIDENCE = "The new default enables parallel builds.";
export const ENGLISH = "Acme CLI v1.2.3 enables parallel builds.";
export const JAPANESE = "Acme CLI v1.2.3 では並列ビルドが有効です。";
export const DESK = "https://desk.example.test";

const assessment = {
  kind: "changelog",
  impact: 3,
  confidence: 0.9,
  why_now: "The new default changes build concurrency.",
  summary: ENGLISH,
  key_points: ["Use `acme build --jobs 4`."],
  engineering_implications: ["Check shared build caches."],
  caveats: ["The claim applies to v1.2.3."],
  citations: [{ locator: RELEASE, quote: EVIDENCE }],
};

const japanese = {
  title: "Acme CLI v1.2.3 のリリース",
  why_now: "新しい既定値により、ビルドの並行処理が変わります。",
  summary: JAPANESE,
  key_points: ["`acme build --jobs 4` を使用してください。", "出典の根拠"],
  engineering_implications: ["共有ビルドキャッシュを確認してください。"],
  caveats: ["この説明は v1.2.3 にのみ適用されます。"],
};

export const config = AppConfigSchema.parse({
  models: {
    triage: { provider: "openrouter", model: "synthetic-triage", max_output_tokens: 500 },
    deep: { provider: "openrouter", model: "synthetic-deep", max_output_tokens: 500 },
    translate: { provider: "openrouter", model: "synthetic-translate", max_output_tokens: 500 },
  },
  delivery: { force_dry_run: false, budget_timezone: "UTC" },
});

export async function publish(
  storage: D1StorageRepositories,
  expectedVersion: number,
  value: AppConfig = config,
): Promise<void> {
  const published = await storage.admin.publishConfig(value, expectedVersion, {
    id: `config-audit-${expectedVersion + 1}`,
    actor: "local-operator",
    at: START + expectedVersion,
  });
  if (published?.version !== expectedVersion + 1) throw new AppError("STATE_CONFLICT");
}

export async function seedSource(storage: D1StorageRepositories): Promise<void> {
  await storage.sources.upsert({
    id: SOURCE,
    key: "github:example/acme",
    kind: "github_repo",
    config_json: {
      kind: "github_repo",
      owner: "Example",
      repo: "Acme",
      strategy: "release_first",
      changelog_path: "CHANGELOG.md",
    },
    cursor_json: {
      kind: "github_repo",
      releases_etag: null,
      tags_etag: null,
      changelog_sha: null,
      known_versions: [],
    },
    poll_interval_sec: 300,
    next_poll_at: START,
    created_at: START,
    updated_at: START,
  });
}

export async function seedDestinations(storage: D1StorageRepositories): Promise<void> {
  const defaults = {
    purpose: "alerts",
    enabled: true,
    dry_run: false,
    min_tier: 1,
    daily_budget: 8,
    source_filters: { hn: true, changelog: true },
    quiet_hours: null,
    created_at: START,
    updated_at: START,
  } as const;
  const destinations = [
    { id: "english", lang: "en", channel: "slack", secret_ref: "TEST_EN" },
    { id: "japanese", lang: "ja", channel: "discord", secret_ref: "TEST_JA" },
    { id: "no-translation", lang: "zh-CN", channel: "slack", secret_ref: "TEST_ZH" },
    { id: "operations", lang: "en", channel: "slack", secret_ref: "TEST_OPS", purpose: "ops" },
  ] as const;
  for (const destination of destinations) {
    await storage.destinations.upsert({
      ...defaults,
      ...destination,
      name: destination.id,
    } satisfies Destination);
  }
}

interface ScriptedHttp {
  readonly calls: string[];
  readonly deepStarted: Promise<void>;
  finishDeep(): void;
  fetch(request: Request): Promise<Response>;
}

function scriptedHttp(): ScriptedHttp {
  const calls: string[] = [];
  const deepStarted = Promise.withResolvers<void>();
  const deepResult = Promise.withResolvers<void>();
  return {
    calls,
    deepStarted: deepStarted.promise,
    finishDeep: () => deepResult.resolve(),
    async fetch(request) {
      const url = new URL(request.url);
      if (
        url.hostname === "api.github.com" &&
        url.pathname.toLowerCase() === "/repos/example/acme/releases"
      ) {
        calls.push("github");
        if (request.headers.get("if-none-match") === '"fixture-release"') {
          return new Response(null, { status: 304 });
        }
        return Response.json(
          [
            {
              tag_name: "v1.2.3",
              name: TITLE,
              body: `\r\n${EVIDENCE}  \r\n\r\n`,
              prerelease: false,
              draft: false,
              published_at: new Date(START - 60_000).toISOString(),
              html_url: RELEASE,
            },
          ],
          { headers: { etag: '"fixture-release"' } },
        );
      }
      const body = await request.text();
      if (url.hostname === "openrouter.ai" && url.pathname === "/api/v1/chat/completions") {
        const input: unknown = JSON.parse(body);
        if (typeof input !== "object" || input === null || !("model" in input)) {
          throw new AppError("INPUT_INVALID");
        }
        switch (input.model) {
          case "synthetic-triage":
            calls.push("triage");
            return completion(input.model, {
              kind: "changelog",
              decision: "pass",
              confidence: 0.9,
              rejection_reason: null,
            });
          case "synthetic-deep":
            calls.push("deep");
            deepStarted.resolve();
            await deepResult.promise;
            return completion(input.model, assessment);
          case "synthetic-translate":
            if (body.includes("into Simplified Chinese.")) {
              calls.push("translate:zh-CN");
              return new Response(null, { status: 400 });
            }
            if (body.includes("into Japanese.")) {
              calls.push("translate:ja");
              return completion(input.model, japanese);
            }
        }
      }
      calls.push("unexpected");
      throw new AppError("FORBIDDEN", { message: "Unexpected test transport request" });
    },
  };
}

function completion(model: string, output: unknown): Response {
  return Response.json({
    model,
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(output) } },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10 },
  });
}

interface OutgoingQueues {
  failNext(queue: QueueName): void;
  take(queue: QueueName): Job[];
  binding(queue: QueueName): CloudflareQueueBinding;
}

function outgoingQueues(): OutgoingQueues {
  const pending = new Map<QueueName, Job[]>();
  const failures = new Set<QueueName>();
  function send(queue: QueueName, jobs: Iterable<Job>): Promise<void> {
    if (failures.delete(queue)) return Promise.reject(new AppError("QUEUE_UNAVAILABLE"));
    pending.set(queue, [...(pending.get(queue) ?? []), ...jobs]);
    return Promise.resolve();
  }
  return {
    failNext: (queue: QueueName): void => {
      failures.add(queue);
    },
    take: (queue: QueueName): Job[] => {
      const jobs = pending.get(queue) ?? [];
      pending.delete(queue);
      return jobs;
    },
    binding: (queue: QueueName): CloudflareQueueBinding => ({
      send: (job) => send(queue, [job]),
      sendBatch: (batch) =>
        send(
          queue,
          Array.from(batch, ({ body }) => body),
        ),
    }),
  };
}

export function message(body: unknown) {
  const dispositions: ("ack" | "retry")[] = [];
  return {
    body,
    dispositions,
    ack: (): void => {
      dispositions.push("ack");
    },
    retry: (): void => {
      dispositions.push("retry");
    },
  };
}

function rejectNetwork(): never {
  throw new AppError("FORBIDDEN", { message: "Unexpected local runtime egress" });
}

interface Scenario {
  readonly worker: PipelineWorker;
  readonly env: PipelineBindings;
  readonly clock: FakeClock;
  readonly outgoing: OutgoingQueues;
  readonly http: ScriptedHttp;
  readonly logs: LogRecord[];
  readonly storage: D1StorageRepositories;
  readonly tick: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export async function startPipeline(): Promise<Scenario> {
  const emulator = new Miniflare({
    host: "127.0.0.1",
    compatibilityDate: "2026-07-30",
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    d1Databases: { DB: "pipeline-test" },
    r2Buckets: { BLOBS: "pipeline-test" },
    outboundService: rejectNetwork,
  });
  try {
    const [database, blobs] = await Promise.all([
      emulator.getD1Database("DB"),
      emulator.getR2Bucket("BLOBS"),
    ]);
    await applyStorageMigrations(database);
    const clock = createFakeClock(START);
    const http = scriptedHttp();
    const outgoing = outgoingQueues();
    const logs: LogRecord[] = [];
    const worker = createPipelineWorker({
      clock,
      ids: createSequentialIdGen("pipeline"),
      telemetry: {
        log: (record) => {
          logs.push(record);
        },
        count: () => undefined,
      },
    });
    const env = {
      DB: database,
      BLOBS: blobs,
      POLL_QUEUE: outgoing.binding("q-poll"),
      TRIAGE_QUEUE: outgoing.binding("q-triage"),
      DEEP_QUEUE: outgoing.binding("q-deep"),
      DELIVER_QUEUE: outgoing.binding("q-deliver"),
      PROVIDER_HTTP: http,
      PINNED_WEB: { resolve: rejectNetwork, fetchPinned: rejectNetwork },
      ENVIRONMENT: "local",
      DESK_ORIGIN: DESK,
      OPENROUTER_API_KEY: "synthetic",
      GITHUB_TOKEN: "synthetic",
    } satisfies PipelineBindings;
    return {
      worker,
      env,
      clock,
      outgoing,
      http,
      logs,
      storage: createD1Storage(database),
      tick: () => worker.scheduled({ scheduledTime: clock.now(), cron: "*/5 * * * *" }, env),
      dispose: () => emulator.dispose(),
    };
  } catch (cause) {
    await emulator.dispose();
    throw cause;
  }
}

export async function syntheticAccess(database: PipelineBindings["DB"]) {
  const issuer = "https://fixture.cloudflareaccess.com";
  const audience = "local-pipeline-desk";
  const kid = "local-fixture";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const assertion = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("fixture-reader")
    .setExpirationTime(4_102_444_800)
    .sign(privateKey);
  return {
    headers: { "Cf-Access-Jwt-Assertion": assertion },
    bindings: {
      DB: database,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: audience,
      ACCESS_JWKS: JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }),
    },
  };
}

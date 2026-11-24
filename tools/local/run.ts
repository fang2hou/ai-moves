// Local operation: runs the real pipeline Worker on a timer against the live Hacker News API
// and the live model provider, serves the public desk, and pushes short cards to the Discord
// mock. Nothing is deployed and no real Discord webhook is called.
import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createPipelineWorker, type PipelineWorker } from "@ai-moves/pipeline/worker";
import { AppConfigSchema } from "@ai-moves/contracts/config";
import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import type { Job, QueueName } from "@ai-moves/contracts/messages";
import { renderDiscord } from "@ai-moves/delivery/render/discord";
import { systemClock } from "@ai-moves/kernel/clock";
import { createIdGen } from "@ai-moves/kernel/id";
import { createD1Storage } from "@ai-moves/storage-d1/d1";
import { applyStorageMigrations } from "@ai-moves/storage-d1/migrations";
import { Miniflare } from "miniflare";
import { build } from "vite";

import { readEnv } from "./env.ts";

// The environment the Worker reads, taken from its own handler so this runner cannot drift
// from the bindings a deployment provides.
type PipelineBindings = Parameters<PipelineWorker["queue"]>[1];

const port = Number(readEnv("DESK_PORT") ?? 8787);
const intervalMs = Number(readEnv("POLL_INTERVAL_SEC") ?? 300) * 1000;
const discordWebhook =
  readEnv("DISCORD_WEBHOOK_URL") ?? "http://127.0.0.1:7373/api/webhooks/1/mock";
const modelKey = readEnv("OPENROUTER_API_KEY") ?? "";
// The routes this project is allowed to run on, free one first. They occasionally
// let a JSON fragment or a citation slip into a string field, which the finalizer
// strips before the text is stored; do not reach for a route outside this list.
const triageModel =
  readEnv("OPENROUTER_TRIAGE_MODEL") ?? "inclusionai/ling-3.2-flash-20261113:free";
const deepModel = readEnv("OPENROUTER_DEEP_MODEL") ?? "inclusionai/ling-3.2-flash-20261113:free";
const fallbacks = (
  readEnv("OPENROUTER_FALLBACKS") ??
  "~deepseek/deepseek-flash-latest,tencent/hy4-flash-20261116,google/gemini-4-hydrogen-20261112"
)
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");
// Reasoning models spend most of their budget before the answer, so keep this generous.
const triageTokens = Number(readEnv("TRIAGE_TOKENS") ?? 8000);
const deepTokens = Number(readEnv("DEEP_TOKENS") ?? 32_000);
// Links the product writes into documents must be https; the mock rewrites this
// prefix to the local desk so the card is clickable while testing.
const DESK_ORIGIN = readEnv("DESK_ORIGIN") ?? "https://desk.example.test";
const SOURCE_ID = "hn-top";
const githubToken = readEnv("GITHUB_TOKEN") ?? "";
// Watched releases and documentation changelogs. A documentation site is polled
// through its Markdown twin when it has one: the rendered page is megabytes of
// application HTML and would be truncated before the entries begin.
const WATCHLIST = [
  { owner: "can1357", repo: "oh-my-pi" },
  { owner: "stablyai", repo: "orca" },
  { owner: "earendil-works", repo: "pi" },
] as const;
const WEB_WATCHLIST = [
  {
    label: "Claude Code",
    page_url: "https://code.claude.com/docs/en/changelog",
    fetch_url: "https://code.claude.com/docs/en/changelog.md",
  },
  { label: "ChatGPT & Codex", page_url: "https://learn.chatgpt.com/docs/changelog" },
  {
    label: "Antigravity",
    page_url: "https://antigravity.google/docs/changelog",
    fetch_url: "https://antigravity.google/docs/changelog.md",
    surfaces: ["Antigravity App", "Antigravity CLI"],
  },
] as const;
const persist = readEnv("STATE_DIR");
const verbose = readEnv("VERBOSE") === "1";
const deepGateMinComments = readEnv("DEEP_GATE_MIN_COMMENTS");
const repoUrl = (path: string): URL => new URL(`../../${path}`, import.meta.url);

function say(line: string): void {
  process.stdout.write(`${new Date(systemClock.now()).toISOString().slice(11, 19)} ${line}\n`);
}

async function bundleDesk(): Promise<string> {
  const result = await build({
    configFile: fileURLToPath(repoUrl("apps/api/vite.config.ts")),
    logLevel: "silent",
    build: { write: false },
  });
  const bundles = Array.isArray(result) ? result : [result];
  const bundle = bundles[0];
  const output = bundle && "output" in bundle ? bundle.output[0] : undefined;
  if (output?.type !== "chunk") throw new Error("Expected one bundled desk module");
  return output.code;
}

// The product resolves first and then requires a connection to that exact address. Node's https
// client pins the socket to `host` while `servername` and the Host header keep TLS and HTTP intact.
function fetchPinned(incoming: Request, address: string): Promise<Response> {
  const url = new URL(incoming.url);
  const headers: Record<string, string> = { host: url.hostname };
  for (const [name, value] of incoming.headers) headers[name] = value;
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      {
        host: address,
        servername: url.hostname,
        port: 443,
        method: incoming.method,
        path: `${url.pathname}${url.search}`,
        headers,
        timeout: 15_000,
      },
      (response) => {
        const status = response.statusCode ?? 502;
        const received = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === "string") received.set(name, value);
          else if (Array.isArray(value)) for (const entry of value) received.append(name, entry);
        }
        const empty = status === 204 || status === 304 || incoming.method === "HEAD";
        const body = empty ? null : Readable.toWeb(response);
        resolve(new Response(body, { status, headers: received }));
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("Pinned request timed out")));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function resolveHost(hostname: string): Promise<readonly string[]> {
  const answers = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  return answers
    .flatMap((answer) => (answer.status === "fulfilled" ? answer.value : []))
    .slice(0, 32);
}

const config = AppConfigSchema.parse({
  ...(deepGateMinComments === undefined
    ? {}
    : { hn: { deep_gate: { min_comments: Number(deepGateMinComments) } } }),
  watchlist: WATCHLIST.map((entry) => ({ ...entry })),
  web_watchlist: WEB_WATCHLIST.map((entry) => ({ ...entry })),
  models: {
    triage: {
      provider: "openrouter",
      model: triageModel,
      fallbacks,
      max_output_tokens: triageTokens,
    },
    deep: { provider: "openrouter", model: deepModel, fallbacks, max_output_tokens: deepTokens },
    translate: {
      provider: "openrouter",
      model: deepModel,
      fallbacks,
      max_output_tokens: deepTokens,
    },
  },
});

const script = await bundleDesk();
const emulator = new Miniflare({
  host: "127.0.0.1",
  port,
  ...(persist === undefined ? {} : { d1Persist: persist, r2Persist: persist }),
  workers: [
    {
      name: "desk",
      compatibilityDate: "2026-07-30",
      modules: true,
      script,
      d1Databases: { DB: "live" },
      r2Buckets: { BLOBS: "live" },
      assets: {
        directory: fileURLToPath(repoUrl("apps/web/dist")),
        binding: "ASSETS",
        routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      },
    },
  ],
});

const database = await emulator.getD1Database("DB", "desk");
const blobs = await emulator.getR2Bucket("BLOBS", "desk");
await applyStorageMigrations(database);
const storage = createD1Storage(database);
const startedAt = systemClock.now();
const current = await storage.config.getCurrent();
await storage.admin.publishConfig(config, current?.version ?? 0, {
  id: `config-${(current?.version ?? 0) + 1}-${startedAt}`,
  actor: "local-operator",
  at: startedAt,
});
await storage.sources.upsert({
  id: SOURCE_ID,
  key: "hn:top",
  kind: "hn_top",
  config_json: { kind: "hn_top", top_n: config.hn.top_n, track_limit: config.hn.track_limit },
  cursor_json: { kind: "hn_top" },
  poll_interval_sec: 300,
  next_poll_at: startedAt,
  created_at: startedAt,
  updated_at: startedAt,
});

for (const entry of config.watchlist) {
  const key = `${entry.owner.toLowerCase()}/${entry.repo.toLowerCase()}`;
  await storage.sources.upsert({
    id: `gh-${key.replace("/", "-")}`,
    key: `github:${key}`,
    kind: "github_repo",
    config_json: {
      kind: "github_repo",
      owner: entry.owner,
      repo: entry.repo,
      strategy: entry.strategy,
      changelog_path: entry.changelog_path,
    },
    cursor_json: {
      kind: "github_repo",
      releases_etag: null,
      tags_etag: null,
      changelog_sha: null,
      known_versions: [],
    },
    poll_interval_sec: entry.poll_interval_sec,
    next_poll_at: startedAt,
    created_at: startedAt,
    updated_at: startedAt,
  });
}
for (const entry of config.web_watchlist) {
  const host = new URL(entry.page_url).hostname;
  await storage.sources.upsert({
    id: `web-${host.replace(/\W+/gu, "-")}`,
    key: `web:${entry.page_url}`,
    kind: "web_page",
    config_json: {
      kind: "web_page",
      label: entry.label,
      page_url: entry.page_url,
      fetch_url: entry.fetch_url ?? entry.page_url,
      surfaces: [...entry.surfaces],
    },
    cursor_json: { kind: "web_page", content_hash: null, latest_markers: [] },
    poll_interval_sec: entry.poll_interval_sec,
    next_poll_at: startedAt,
    created_at: startedAt,
    updated_at: startedAt,
  });
}

const pending = new Map<QueueName, Job[]>();
const append = (name: QueueName, jobs: readonly Job[]): Promise<void> => {
  pending.set(name, [...(pending.get(name) ?? []), ...jobs]);
  return Promise.resolve();
};
const binding = (name: QueueName): PipelineBindings["POLL_QUEUE"] => ({
  send: (body) => append(name, [body]),
  sendBatch: (messages) =>
    append(
      name,
      [...messages].map(({ body }) => body),
    ),
});

const worker = createPipelineWorker({
  clock: systemClock,
  ids: createIdGen({ clock: systemClock }),
  telemetry: {
    log: (record) => {
      if (!verbose && (record.level === "debug" || record.level === "info")) return;
      say(`  [${record.level}] ${record.event} ${JSON.stringify(record.err ?? record.attrs)}`);
    },
    count: () => undefined,
  },
});

const env: PipelineBindings = {
  DB: database,
  BLOBS: blobs,
  POLL_QUEUE: binding("q-poll"),
  TRIAGE_QUEUE: binding("q-triage"),
  DEEP_QUEUE: binding("q-deep"),
  DELIVER_QUEUE: binding("q-deliver"),
  PROVIDER_HTTP: { fetch: (outgoing: Request) => fetch(outgoing) },
  PINNED_WEB: { resolve: resolveHost, fetchPinned },
  ENVIRONMENT: "local",
  LOG_LEVEL: verbose ? "info" : "warn",
  DESK_ORIGIN,
  OPENROUTER_API_KEY: modelKey === "" ? "absent-local-key" : modelKey,
  GITHUB_TOKEN: githubToken === "" ? "absent-local-token" : githubToken,
};

// The Worker rejects a batch larger than a consumer batch, the same as the real
// queue would, so a cycle that produces many candidates is delivered in waves.
const BATCH = 10;

async function drain(): Promise<void> {
  for (let pass = 0; pass < 2000; pass++) {
    const next = [...pending].find(([, jobs]) => jobs.length > 0);
    if (next === undefined) return;
    const [name, queued] = next;
    const jobs = queued.slice(0, BATCH);
    pending.set(name, queued.slice(BATCH));
    await worker.queue(
      {
        queue: name,
        messages: jobs.map((body) => ({
          body,
          timestamp: new Date(systemClock.now()),
          attempts: 1,
          ack: () => undefined,
          retry: () => say(`  ${name} retry requested`),
        })),
      },
      env,
    );
  }
}

// One card per story, sent the first time it has a document. A refresh overwrites
// the page but does not notify again.
const notified = new Set<string>();

async function notifyNewDocuments(): Promise<void> {
  const alerts = await storage.alerts.listFeed({ limit: 20 });
  for (const alert of alerts.toReversed()) {
    if (notified.has(alert.item_id)) continue;
    const document = await storage.alerts.getDocument(alert.id, config.profile.output_lang);
    if (document === null) continue;
    notified.add(alert.item_id);
    await sendCard(document);
  }
}

async function sendCard(document: AlertDoc): Promise<void> {
  try {
    const response = await fetch(`${discordWebhook}?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "AI Moves", ...renderDiscord(document) }),
    });
    say(`→ discord ${response.status}: ${document.title.original.slice(0, 60)}`);
  } catch (cause) {
    say(`→ discord failed: ${String(cause)}`);
  }
}

async function summarize(): Promise<void> {
  const states = await database
    .prepare("SELECT state, count(*) AS n FROM items GROUP BY state ORDER BY n DESC")
    .all<{ state: string; n: number }>();
  const published = await database
    .prepare(
      `SELECT count(*) AS n FROM alerts WHERE documents_json IS NOT NULL AND documents_json != '[]'`,
    )
    .first<{ n: number }>();
  say(
    `items ${states.results.map(({ state, n }) => `${state}=${n}`).join(" ") || "none"} | ` +
      `published=${published?.n ?? 0}`,
  );
}

async function cycle(): Promise<void> {
  try {
    await worker.scheduled({ scheduledTime: systemClock.now(), cron: "*/5 * * * *" }, env);
    await drain();
    await notifyNewDocuments();
    await summarize();
  } catch (cause) {
    say(`cycle failed: ${String(cause)}`);
  }
}

say(`desk   http://127.0.0.1:${port}/`);
say(`discord mock ${discordWebhook}`);
say(
  `model  triage ${triageModel}, deep ${deepModel}` +
    (fallbacks.length === 0 ? "" : ` (fallback ${fallbacks.join(", ")})`),
);
if (modelKey === "")
  say("OPENROUTER_API_KEY is unset: polling and scoring run, analysis does not.");
say(
  `watching hn top ${config.hn.top_n}, ${config.watchlist.length} repos, ` +
    `${config.web_watchlist.length} doc changelogs`,
);
if (githubToken === "") say("GITHUB_TOKEN is unset: release polling will fail.");
say(`polling every ${intervalMs / 1000}s`);

await cycle();
const timer = setInterval(() => void cycle(), intervalMs);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    void emulator.dispose().then(() => process.exit(0));
  });
}

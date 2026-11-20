import { AppConfigSchema, type AppConfigInput } from "@ai-moves/contracts/config";
import type { Alert, Analysis, Item, RepoRef, Source } from "@ai-moves/contracts/entities";
import type { DeepJob, TriageJob } from "@ai-moves/contracts/messages";
import type { GenerateStructuredResult } from "@ai-moves/contracts/ports/llm";
import type { BudgetRequest } from "@ai-moves/contracts/ports/storage";
import type { Lang } from "@ai-moves/contracts/primitives";
import { isItemTransitionAllowed } from "@ai-moves/contracts/states";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { createInMemoryBlobStore } from "@ai-moves/testing/fakes/blob-store";
import { createFakeClock } from "@ai-moves/testing/fakes/clock";
import { createSequentialIdGen } from "@ai-moves/testing/fakes/id-gen";
import { createInMemoryJobBus } from "@ai-moves/testing/fakes/job-bus";
import { createScriptedLlmClient } from "@ai-moves/testing/fakes/llm";

import type { DeepDependencies } from "../src/deep.ts";
import type { FinalizationRequest } from "../src/finalization.ts";
import type { TriageDependencies } from "../src/triage.ts";

export const url = "https://example.test/notes";
export const notes = "The release enables parallel builds by default.";
export const deepJob: DeepJob = { v: 1, type: "deep", item_id: "item", trace_id: "deep_trace" };
export const triageJob: TriageJob = {
  v: 1,
  type: "triage",
  item_id: "item",
  trace_id: "triage_trace",
};
export const model = { provider: "fixture", model: "configured", max_output_tokens: 1000 };
export const usage = { input_tokens: 20, output_tokens: 10, cost_usd: null };

export const pass = {
  kind: "changelog",
  decision: "pass",
  confidence: 0.9,
  rejection_reason: null,
};
export const assessment = {
  kind: "changelog",
  impact: 3,
  confidence: 0.9,
  why_now: "The new default changes build concurrency.",
  summary: "Acme CLI v1.2.3 enables parallel builds.",
  key_points: ["Use `acme build --jobs 4`."],
  engineering_implications: ["Check shared build caches."],
  caveats: ["The claim applies to v1.2.3."],
  citations: [{ locator: url, quote: notes }],
};
export const japanese = {
  title: "Acme CLI v1.2.3 のリリース",
  why_now: "新しい既定値により、ビルドの並行処理が変わります。",
  summary: "Acme CLI v1.2.3 では並列ビルドが有効です。",
  key_points: ["`acme build --jobs 4` を使用してください。", "出典の根拠"],
  engineering_implications: ["共有ビルドキャッシュを確認してください。"],
  caveats: ["この説明は v1.2.3 にのみ適用されます。"],
};

type ModelStep =
  | { readonly kind: "return"; readonly value: GenerateStructuredResult<unknown> }
  | { readonly kind: "reject"; readonly error: AppError };

export function respond(output: unknown): ModelStep {
  return {
    kind: "return",
    value: { output, model: "fixture-fallback", repaired: false, usedFallback: true, usage },
  };
}

const source: Source = {
  id: "source",
  key: "github:example/acme",
  kind: "github_repo",
  config_json: {
    kind: "github_repo",
    owner: "example",
    repo: "acme",
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
  next_poll_at: 0,
  consecutive_failures: 0,
  status: "active",
  last_success_at: null,
  created_at: 0,
  updated_at: 0,
};

export async function fixture({
  state = "candidate",
  steps = [],
  languages = ["en"],
  ai = {},
  changelog = {},
  retry = {},
  repository = { owner: "Example", repo: "Acme" },
  sourceId = "source",
  itemId = "item",
  sourceUrl = url,
}: {
  state?: Item["state"];
  steps?: readonly ModelStep[];
  languages?: readonly Lang[];
  ai?: NonNullable<AppConfigInput["ai"]>;
  changelog?: NonNullable<AppConfigInput["changelog"]>;
  retry?: NonNullable<AppConfigInput["retry"]>;
  repository?: RepoRef;
  sourceId?: string;
  itemId?: string;
  sourceUrl?: string;
} = {}) {
  const clock = createFakeClock();
  const blobs = createInMemoryBlobStore();
  const ref = await blobs.put(notes, { contentType: "text/plain" });
  let item: Item = {
    id: itemId,
    source_id: sourceId,
    external_key: "github:example/acme@v1.2.3",
    kind: "changelog",
    url: sourceUrl,
    title: "Acme CLI v1.2.3",
    published_at: clock.now(),
    content_hash: ref.content_hash,
    revision: 1,
    state,
    state_updated_at: clock.now(),
    score_json: { kind: "changelog", prior: 65, signals: [], computed_at: clock.now() },
    tier: null,
    cluster_id: "cluster",
    attempts: 0,
    next_attempt_at: null,
    first_seen_at: clock.now(),
    last_seen_at: clock.now(),
  };
  const rows = new Map<string, Analysis>();
  const owners = new Map<string, { owner: string; expiresAt: number }>();
  const receipts: BudgetRequest[] = [];
  const budgetUsage = new Map<string, number>();
  const finalized: FinalizationRequest[] = [];
  const alerts = new Map<string, Alert>();
  const llm = createScriptedLlmClient(steps);
  const jobs = createInMemoryJobBus();
  let crashState: Item["state"] | null = null;
  let crashFinalization = false;

  const deps: DeepDependencies & TriageDependencies = {
    config: AppConfigSchema.parse({
      models: { triage: model, deep: model, translate: model },
      ai,
      changelog,
      retry,
    }),
    configVersion: 3,
    clock,
    blobs,
    llm,
    jobs,
    ids: createSequentialIdGen("owner"),
    items: {
      get: () => Promise.resolve({ ...item }),
      transition: (transition) => {
        if (transition.to === crashState) {
          crashState = null;
          throw new AppError("STORAGE_UNAVAILABLE");
        }
        if (
          item.state !== transition.from ||
          !isItemTransitionAllowed(transition.from, transition.to) ||
          transition.expected?.attempts !== item.attempts ||
          transition.expected.state_updated_at !== item.state_updated_at
        )
          return Promise.resolve(false);
        item = {
          ...item,
          ...transition.patch,
          state: transition.to,
          state_updated_at: transition.at,
        };
        return Promise.resolve(true);
      },
    },
    analyses: {
      findByKey: (key) =>
        Promise.resolve(
          [...rows.values()].find(
            (row) =>
              key.item_id === row.item_id &&
              key.lang === row.lang &&
              key.stage === row.stage &&
              key.input_hash === row.input_hash &&
              key.prompt_version === row.prompt_version,
          ) ?? null,
        ),
      insertIfAbsent: (row) => {
        const existing = rows.get(row.id);
        if (existing !== undefined) return Promise.resolve({ value: existing, created: false });
        rows.set(row.id, row);
        return Promise.resolve({ value: row, created: true });
      },
      claim: (id, lease) => {
        if (rows.get(id)?.status !== "pending" || (owners.get(id)?.expiresAt ?? 0) > lease.now)
          return Promise.resolve(false);
        owners.set(id, lease);
        return Promise.resolve(true);
      },
      complete: (id, owner, { at, ...completion }) => {
        const row = rows.get(id);
        const lease = owners.get(id);
        if (row?.status !== "pending" || lease?.owner !== owner || lease.expiresAt <= at) {
          return Promise.resolve(false);
        }
        rows.set(id, { ...row, ...completion, updated_at: at });
        owners.delete(id);
        return Promise.resolve(true);
      },
    },
    budgets: {
      tryConsume: (request) => {
        const key = `${request.day}:${request.scope}`;
        const used = budgetUsage.get(key) ?? 0;
        const granted = used + request.amount <= request.limit;
        if (granted) budgetUsage.set(key, used + request.amount);
        receipts.push(request);
        return Promise.resolve({
          granted,
          entry: {
            day: request.day,
            scope: request.scope,
            used: budgetUsage.get(key) ?? 0,
            limit: request.limit,
          },
        });
      },
    },
    revisions: {
      listByItem: () =>
        Promise.resolve([
          {
            item_id: itemId,
            content_hash: ref.content_hash,
            origin: "release",
            r2_key: ref.key,
            observed_at: 0,
          },
        ]),
    },
    sources: {
      get: (id) =>
        Promise.resolve(
          id === sourceId
            ? { ...source, id, config_json: { ...source.config_json, ...repository } }
            : null,
        ),
    },
    snapshots: { listSince: () => Promise.resolve([]) },
    hn: {
      getStory: () => Promise.reject(new AppError("INPUT_INVALID")),
      getCommentTree: () => Promise.reject(new AppError("INPUT_INVALID")),
    },
    web: { fetchText: () => Promise.reject(new AppError("INPUT_INVALID")) },
    alerts: { getByKey: (key) => Promise.resolve(alerts.get(key) ?? null) },
    destinations: {
      list: () =>
        Promise.resolve(
          languages.map((lang) => ({
            id: `destination-${lang}`,
            name: `fixture-${lang}`,
            purpose: "alerts",
            channel: "slack",
            secret_ref: "SYNTHETIC_REFERENCE",
            lang,
            enabled: true,
            dry_run: true,
            min_tier: 1,
            daily_budget: 5,
            source_filters: { hn: true, changelog: true },
            quiet_hours: null,
            created_at: 0,
            updated_at: 0,
          })),
        ),
    },
    detailUrl: (id) => `https://feed.example.test/items/${id}`,
    finalize: (request) => {
      finalized.push(request);
      const canonical = alerts.get(request.alert.alert_key) ?? request.alert;
      alerts.set(canonical.alert_key, canonical);
      if (crashFinalization) {
        crashFinalization = false;
        throw new AppError("QUEUE_UNAVAILABLE");
      }
      return Promise.resolve(canonical);
    },
  };
  return {
    deps,
    rows,
    receipts,
    finalized,
    alerts,
    clock,
    llm,
    jobs,
    blobs,
    item: (): Item => item,
    interruptTransition: (target: Item["state"]): void => {
      crashState = target;
    },
    interruptFinalization: (): void => {
      crashFinalization = true;
    },
    recover: async (target: "candidate" | "triaged_pass"): Promise<void> => {
      await deps.items.transition({
        id: item.id,
        from: item.state,
        to: target,
        at: clock.now(),
        expected: item,
      });
    },
  };
}

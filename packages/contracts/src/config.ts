import { z } from "zod";

import type { AnalysisStage } from "./states.ts";

import { LogLevelSchema } from "./logging.ts";
import {
  HttpsUrlSchema,
  LangSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  TimeOfDaySchema,
  TimeZoneSchema,
  UnitIntervalSchema,
} from "./primitives.ts";
import { GitHubRepoStrategySchema, HeatLevelSchema } from "./states.ts";

// Versioned application configuration. Every default is the value stated in
// docs/architecture-v1.md; the section is noted per group. Objects are strict so a misspelled key
// fails validation instead of silently leaving a switch at its default.

const strict = z.strictObject;

function positive(defaultValue: number): z.ZodDefault<z.ZodInt> {
  return PositiveIntSchema.default(defaultValue);
}

// 5.4
export const ModelConfigSchema = strict({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  fallbacks: z.array(z.string().min(1).max(128)).max(3).default([]),
  max_output_tokens: PositiveIntSchema,
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ModelsConfigSchema = strict({
  triage: ModelConfigSchema,
  deep: ModelConfigSchema,
  translate: ModelConfigSchema,
});

// The polish pass rewrites a finished document rather than reading evidence, which is
// the translator's kind of work, so it runs on the translator's route. Keeping it out
// of the configuration means a stored configuration stays valid.
export function stageModels(
  models: z.output<typeof ModelsConfigSchema>,
): Readonly<Record<AnalysisStage, ModelConfig>> {
  return { ...models, polish: models.translate };
}

// 5.3
export const AiConfigSchema = strict({
  enabled: z.boolean().default(true),
  triage_items_per_day: NonNegativeIntSchema.default(2000),
  deep_per_day: NonNegativeIntSchema.default(1000),
  triage_batch_input_tokens: positive(6000),
  deep_input_tokens: positive(12_000),
  // A story with a live document is re-analyzed on this cadence, feeding the
  // previous conclusion plus only the comments added since the last pass.
  refresh_interval_minutes: positive(60),
  refresh_min_new_comments: NonNegativeIntSchema.default(5),
  refresh_max_age_hours: positive(48),
  budget_alert_ratio: UnitIntervalSchema.default(0.8),
});

export const ProfileConfigSchema = strict({
  topics: z
    .array(z.string().min(1).max(200))
    .min(1)
    .default(["AI engineering", "coding agents", "model releases", "developer tools"]),
  // Products the reader uses day to day. A change that touches one of these earns
  // its place in a reading even when it would otherwise look minor.
  products: z
    .array(z.string().min(1).max(100))
    .max(20)
    .default(["Codex", "Claude", "GLM", "Antigravity"]),
  // Analysis writes directly in English unless the deployment selects another language.
  output_lang: LangSchema.default("en"),
});

// 6.1
export const HnHeatWeightsSchema = strict({
  vp: UnitIntervalSchema.default(0.35),
  vc: UnitIntervalSchema.default(0.25),
  climb: UnitIntervalSchema.default(0.15),
  acc: UnitIntervalSchema.default(0.15),
  points: UnitIntervalSchema.default(0.1),
}).refine(
  (weights) =>
    Math.abs(weights.vp + weights.vc + weights.climb + weights.acc + weights.points - 1) < 1e-9,
  { message: "heat weights must sum to 1" },
);

export const HnConfigSchema = strict({
  window_minutes: positive(30),
  top_n: positive(30),
  track_limit: positive(60),
  fetch_concurrency: positive(6),
  snapshot_retention_hours: positive(72),
  heat_weights: HnHeatWeightsSchema.prefault({}),
  heat_levels: strict({
    h1: z.number().min(0).max(100).default(60),
    h2: z.number().min(0).max(100).default(75),
    h3: z.number().min(0).max(100).default(90),
  })
    .refine((levels) => levels.h1 <= levels.h2 && levels.h2 <= levels.h3, {
      message: "heat levels must be ascending",
    })
    .prefault({}),
  gate_burst: strict({
    consecutive_samples: positive(2),
    heat: z.number().min(0).max(100).default(60),
    single_sample_heat: z.number().min(0).max(100).default(80),
    min_points: NonNegativeIntSchema.default(30),
    max_age_hours: positive(24),
  }).prefault({}),
  gate_discussion: strict({
    vc_percentile: UnitIntervalSchema.default(0.85),
    min_comments: NonNegativeIntSchema.default(40),
  }).prefault({}),
  gate_sustained: strict({
    consecutive_samples: positive(6),
    max_rank: positive(10),
    min_points: NonNegativeIntSchema.default(150),
    max_age_hours: positive(24),
  }).prefault({}),
  // Heat is normalized against fixed reference rates rather than a cross-day
  // percentile distribution: a Hacker News story rarely outlives a single day,
  // so a multi-day baseline never fills in time to score the burst it exists for.
  reference: strict({
    vp_per_hour: z.number().positive().default(60),
    vc_per_hour: z.number().positive().default(40),
    climb_per_window: z.number().positive().default(10),
    acc_per_hour: z.number().positive().default(40),
    points: z.number().positive().default(300),
  }).prefault({}),
  // Waiting for a thread to mature costs the lead time the product exists to
  // capture, so analysis starts on a thin discussion and the refresh pass
  // improves it as comments arrive.
  deep_gate: strict({
    min_comments: NonNegativeIntSchema.default(3),
    max_wait_minutes: positive(10),
  }).prefault({}),
});

// 6.2
export const ChangelogConfigSchema = strict({
  prior_points: strict({
    new_surface: z.int().default(30),
    breaking: z.int().default(25),
    default_change: z.int().default(15),
    long_notes: z.int().default(10),
    semver_minor_or_major: z.int().default(10),
    fix_or_deps_only: z.int().default(-20),
    prerelease: z.int().default(-10),
  }).prefault({}),
  long_notes_z_score: z.number().default(1),
  max_triage_per_repo_per_day: positive(3),
  min_revision_diff_chars: NonNegativeIntSchema.default(200),
  deep_gate: strict({
    min_impact: z.int().min(0).max(3).default(2),
    low_impact: z.int().min(0).max(3).default(1),
    low_impact_min_prior: z.number().min(0).max(100).default(50),
  }).prefault({}),
});

// 6.4
export const PushConfigSchema = strict({
  hn: strict({
    min_importance: z.int().min(1).max(5).default(4),
    borderline_importance: z.int().min(1).max(5).default(3),
    borderline_min_heat_level: HeatLevelSchema.default("H1"),
  }).prefault({}),
  changelog: strict({
    min_impact: z.int().min(0).max(3).default(3),
    borderline_impact: z.int().min(0).max(3).default(2),
    borderline_min_prior: z.number().min(0).max(100).default(40),
  }).prefault({}),
});

// 9.3 and 4.4
export const DeliveryConfigSchema = strict({
  paused: z.boolean().default(false),
  force_dry_run: z.boolean().default(true),
  // While true, an alert is recorded and shown on the desk but never sent. The
  // rollout starts here and a published configuration turns it off.
  feed_only: z.boolean().default(true),
  daily_budget_per_destination: NonNegativeIntSchema.default(8),
  daily_cap_per_source: strict({
    hn: NonNegativeIntSchema.default(10),
    changelog: NonNegativeIntSchema.default(5),
  }).prefault({}),
  low_budget_threshold: NonNegativeIntSchema.default(2),
  min_interval_minutes: NonNegativeIntSchema.default(10),
  budget_timezone: TimeZoneSchema.default("Asia/Tokyo"),
  quiet_hours: strict({
    start: TimeOfDaySchema.default("23:00"),
    end: TimeOfDaySchema.default("07:00"),
    timezone: TimeZoneSchema.default("Asia/Tokyo"),
  }).prefault({}),
  max_updates_per_item: NonNegativeIntSchema.default(1),
  // How recent a release has to be to count as news. A documentation changelog may
  // go several days between versions, and the newest version on the page is still
  // the newest there is, so this window is a week rather than a day.
  expiry_hours: strict({
    hn: positive(6),
    changelog: positive(168),
  }).prefault({}),
  ops_max_per_hour: NonNegativeIntSchema.default(1),
});

// 4.4 and 4.5
export const RetryConfigSchema = strict({
  deliver: strict({
    max_attempts: positive(5),
    backoff_seconds: z.array(PositiveIntSchema).min(1).default([30, 120, 600, 1800]),
  }).prefault({}),
  poll: strict({
    degraded_after_failures: positive(3),
    max_backoff_seconds: positive(3600),
  }).prefault({}),
  analysis: strict({
    max_queue_retries: NonNegativeIntSchema.default(3),
    repair_retries: NonNegativeIntSchema.default(1),
    fallback_attempts: NonNegativeIntSchema.default(1),
  }).prefault({}),
});

// 4.5 and 11.2
export const LeaseConfigSchema = strict({
  triage_minutes: positive(10),
  deep_minutes: positive(15),
  deliver_minutes: positive(5),
});

// Section 10 fixes the web fetch timeout at 10 s. The other timeouts are not stated in the
// architecture; these are conservative defaults to revisit in the adapter slices.
export const TimeoutConfigSchema = strict({
  web_fetch_ms: positive(10_000),
  // Covers a full comment tree: 60 item requests at the configured concurrency.
  hn_ms: positive(30_000),
  github_ms: positive(10_000),
  // A reasoning model writing a full document spends most of its budget before
  // the first output token; 60s was not enough and the stage retried forever.
  llm_ms: positive(180_000),
  notifier_ms: positive(10_000),
});

// 10
export const WebFetchConfigSchema = strict({
  max_redirects: NonNegativeIntSchema.default(3),
  max_bytes: positive(1_048_576),
  content_types: z
    .array(z.string().min(1).max(100))
    .min(1)
    .default(["text/html", "text/plain", "text/markdown", "application/xhtml+xml"]),
  denied_domains: z.array(z.string().min(1).max(253)).default([]),
});

// 11.2
export const HealthConfigSchema = strict({
  tick_stale_minutes: positive(15),
  source_stale_intervals: positive(3),
  queue_stale_minutes: positive(30),
});

// 8.1
export const WatchlistEntrySchema = strict({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  strategy: GitHubRepoStrategySchema.default("release_first"),
  changelog_path: z.string().min(1).max(255).default("CHANGELOG.md"),
  poll_interval_sec: z.int().min(300).multipleOf(300).default(600),
});
export type WatchlistEntry = z.infer<typeof WatchlistEntrySchema>;

// A changelog that lives on a documentation site instead of in a repository.
// `fetch_url` defaults to the page itself and exists so a site that also serves a
// Markdown twin can be polled without downloading megabytes of application HTML.
export const WebWatchlistEntrySchema = strict({
  label: z.string().min(1).max(100),
  page_url: HttpsUrlSchema,
  fetch_url: HttpsUrlSchema.optional(),
  // Named second-level headings to follow when the page groups releases by product
  // surface. Empty follows the whole page.
  surfaces: z.array(z.string().min(1).max(100)).max(20).default([]),
  poll_interval_sec: z.int().min(300).multipleOf(300).default(1800),
});
export type WebWatchlistEntry = z.infer<typeof WebWatchlistEntrySchema>;

export const AppConfigSchema = strict({
  models: ModelsConfigSchema,
  ai: AiConfigSchema.prefault({}),
  profile: ProfileConfigSchema.prefault({}),
  hn: HnConfigSchema.prefault({}),
  changelog: ChangelogConfigSchema.prefault({}),
  push: PushConfigSchema.prefault({}),
  delivery: DeliveryConfigSchema.prefault({}),
  retry: RetryConfigSchema.prefault({}),
  leases: LeaseConfigSchema.prefault({}),
  timeouts: TimeoutConfigSchema.prefault({}),
  web_fetch: WebFetchConfigSchema.prefault({}),
  health: HealthConfigSchema.prefault({}),
  watchlist: z.array(WatchlistEntrySchema).default([]),
  web_watchlist: z.array(WebWatchlistEntrySchema).default([]),
});
export type AppConfig = z.output<typeof AppConfigSchema>;
export type AppConfigInput = z.input<typeof AppConfigSchema>;

export const WEB_HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;

export function normalizeDeniedWebDomain(domain: string): string | undefined {
  if (/[/\\?#:@%\s]/u.test(domain)) return undefined;
  const hostname = URL.parse(`https://${domain}`)?.hostname.replace(/\.$/, "");
  return hostname !== undefined && WEB_HOSTNAME.test(hostname) ? hostname : undefined;
}

export function pipelineConfigIssue(config: AppConfig): string | undefined {
  if (Object.values(config.timeouts).some((timeout) => timeout > 2_147_483_647)) {
    return "Pipeline timeout exceeds the timer range";
  }
  if (
    config.web_fetch.denied_domains.some((domain) => normalizeDeniedWebDomain(domain) === undefined)
  ) {
    return "Invalid denied web domain";
  }
  return undefined;
}

export const ENVIRONMENTS = ["local", "dev", "production"] as const;
export const EnvironmentSchema = z.enum(ENVIRONMENTS);
export type Environment = z.infer<typeof EnvironmentSchema>;

// Non-secret runtime variables of a deployment unit. Platform bindings and secrets share the same
// environment object, so unknown keys are ignored rather than rejected.
export const RuntimeEnvSchema = z.object({
  ENVIRONMENT: EnvironmentSchema,
  LOG_LEVEL: LogLevelSchema.default("info"),
});
export type RuntimeEnv = z.output<typeof RuntimeEnvSchema>;

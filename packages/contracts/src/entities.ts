import { z } from "zod";

import { AppConfigSchema } from "./config.ts";
import { ErrorCodeSchema, ErrorSummarySchema } from "./errors.ts";
import {
  ContentHashSchema,
  DayKeySchema,
  EntityIdSchema,
  EpochMsSchema,
  HttpsUrlSchema,
  HttpUrlSchema,
  JsonObjectSchema,
  JsonValueSchema,
  LangSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  SecretRefSchema,
  TimeOfDaySchema,
  TimeZoneSchema,
} from "./primitives.ts";
import { ItemScoreSchema } from "./scoring.ts";
import {
  AlertBlockReasonSchema,
  AlertDecisionSchema,
  AlertKindSchema,
  AlertTierSchema,
  AnalysisStageSchema,
  AnalysisStatusSchema,
  DeliveryStateSchema,
  DeliverySuppressionReasonSchema,
  DestinationChannelSchema,
  DestinationPurposeSchema,
  GitHubRepoStrategySchema,
  HeatLevelSchema,
  ItemKindSchema,
  ItemStateSchema,
  RevisionOriginSchema,
  SourceKindSchema,
  SourceStatusSchema,
} from "./states.ts";

// Field names follow architecture 4.1. A `*_json` field holds the parsed value; the suffix records
// that storage serialises it as JSON text.

export const POLL_INTERVAL_STEP_SEC = 300;

const GitHubNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/);

export const RepoRefSchema = z.object({ owner: GitHubNameSchema, repo: GitHubNameSchema });
export type RepoRef = z.infer<typeof RepoRefSchema>;

export const HnTopSourceConfigSchema = z.object({
  kind: z.literal("hn_top"),
  top_n: z.int().min(1).max(500),
  track_limit: z.int().min(1).max(500),
});

export const GitHubRepoSourceConfigSchema = RepoRefSchema.extend({
  kind: z.literal("github_repo"),
  strategy: GitHubRepoStrategySchema,
  changelog_path: z.string().min(1).max(255),
});

// A changelog published as a web page rather than a repository. `fetch_url` is what
// the poller downloads and `page_url` is what a reader opens: documentation sites
// serve a small Markdown twin of a page that is megabytes of HTML.
export const WebPageSourceConfigSchema = z.object({
  kind: z.literal("web_page"),
  label: z.string().min(1).max(100),
  page_url: HttpsUrlSchema,
  fetch_url: HttpsUrlSchema,
  // Second-level headings worth following, for a page that groups releases by
  // product surface. Empty follows every release on the page.
  surfaces: z.array(z.string().min(1).max(100)).max(20),
});

export const SourceConfigSchema = z.discriminatedUnion("kind", [
  HnTopSourceConfigSchema,
  GitHubRepoSourceConfigSchema,
  WebPageSourceConfigSchema,
]);
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export const HnTopSourceCursorSchema = z.object({ kind: z.literal("hn_top") });

export const GitHubRepoSourceCursorSchema = z.object({
  kind: z.literal("github_repo"),
  releases_etag: z.string().max(256).nullable(),
  tags_etag: z.string().max(256).nullable(),
  changelog_sha: z.string().max(64).nullable(),
  known_versions: z.array(z.string().min(1).max(128)),
});

export const WebPageSourceCursorSchema = z.object({
  kind: z.literal("web_page"),
  content_hash: z.string().max(64).nullable(),
  // The newest release seen for each product surface on the page. A changelog is
  // ordered newest first within a surface, so one high-water mark per surface tells
  // which releases are new, and unlike a set of known versions it cannot drop an old
  // entry and read it again as new. A page with no surfaces keeps one mark under "".
  latest_markers: z
    .array(z.object({ surface: z.string().max(100), marker: z.string().min(1).max(300) }))
    .max(20),
});

export const SourceCursorSchema = z.discriminatedUnion("kind", [
  HnTopSourceCursorSchema,
  GitHubRepoSourceCursorSchema,
  WebPageSourceCursorSchema,
]);
export type SourceCursor = z.infer<typeof SourceCursorSchema>;

export const SourceSchema = z
  .object({
    id: EntityIdSchema,
    key: z.string().min(1).max(255),
    kind: SourceKindSchema,
    config_json: SourceConfigSchema,
    poll_interval_sec: z.int().min(POLL_INTERVAL_STEP_SEC).multipleOf(POLL_INTERVAL_STEP_SEC),
    next_poll_at: EpochMsSchema,
    cursor_json: SourceCursorSchema,
    consecutive_failures: NonNegativeIntSchema,
    status: SourceStatusSchema,
    last_success_at: EpochMsSchema.nullable(),
    created_at: EpochMsSchema,
    updated_at: EpochMsSchema,
  })
  .refine((source) => source.config_json.kind === source.kind, {
    path: ["config_json", "kind"],
    message: "config_json.kind must equal kind",
  })
  .refine((source) => source.cursor_json.kind === source.kind, {
    path: ["cursor_json", "kind"],
    message: "cursor_json.kind must equal kind",
  });
export type Source = z.infer<typeof SourceSchema>;

export const ItemSchema = z.object({
  id: EntityIdSchema,
  source_id: EntityIdSchema,
  external_key: z.string().min(1).max(512),
  kind: ItemKindSchema,
  url: HttpUrlSchema.nullable(),
  title: z.string().min(1).max(1000),
  published_at: EpochMsSchema.nullable(),
  content_hash: ContentHashSchema.nullable(),
  revision: NonNegativeIntSchema,
  state: ItemStateSchema,
  state_updated_at: EpochMsSchema,
  score_json: ItemScoreSchema.nullable(),
  tier: HeatLevelSchema.nullable(),
  cluster_id: z.string().min(1).max(128).nullable(),
  attempts: NonNegativeIntSchema,
  next_attempt_at: EpochMsSchema.nullable(),
  first_seen_at: EpochMsSchema,
  last_seen_at: EpochMsSchema,
});
export type Item = z.infer<typeof ItemSchema>;

export const ItemSnapshotSchema = z.object({
  item_id: EntityIdSchema,
  sampled_at: EpochMsSchema,
  rank: PositiveIntSchema.nullable(),
  points: NonNegativeIntSchema,
  comments: NonNegativeIntSchema,
});
export type ItemSnapshot = z.infer<typeof ItemSnapshotSchema>;

export const ItemRevisionSchema = z.object({
  item_id: EntityIdSchema,
  content_hash: ContentHashSchema,
  origin: RevisionOriginSchema,
  blob_key: z.string().min(1).max(512),
  observed_at: EpochMsSchema,
});
export type ItemRevision = z.infer<typeof ItemRevisionSchema>;

export const LlmUsageSchema = z.object({
  input_tokens: NonNegativeIntSchema,
  output_tokens: NonNegativeIntSchema,
  cost_usd: z.number().nonnegative().nullable(),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

export const AnalysisKeySchema = z.object({
  item_id: EntityIdSchema,
  stage: AnalysisStageSchema,
  input_hash: ContentHashSchema,
  prompt_version: z.string().min(1).max(64),
  lang: LangSchema,
});
export type AnalysisKey = z.infer<typeof AnalysisKeySchema>;

export const AnalysisSchema = AnalysisKeySchema.extend({
  id: EntityIdSchema,
  model: z.string().min(1).max(128),
  config_version: PositiveIntSchema,
  status: AnalysisStatusSchema,
  output_json: JsonValueSchema.nullable(),
  blob_key: z.string().min(1).max(512).nullable(),
  usage_json: LlmUsageSchema.nullable(),
  error_code: ErrorCodeSchema.nullable(),
  created_at: EpochMsSchema,
  updated_at: EpochMsSchema,
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const AlertDecisionReasonSchema = z.object({
  why_now: z.string().min(1).max(500),
  blocked_by: z.array(AlertBlockReasonSchema),
  importance: z.int().min(1).max(5).nullable(),
  impact: z.int().min(0).max(3).nullable(),
  heat_level: HeatLevelSchema.nullable(),
  prior: z.number().min(0).max(100).nullable(),
});
export type AlertDecisionReason = z.infer<typeof AlertDecisionReasonSchema>;

export const AlertSchema = z.object({
  id: EntityIdSchema,
  alert_key: ContentHashSchema,
  item_id: EntityIdSchema,
  analysis_id: EntityIdSchema,
  cluster_id: z.string().min(1).max(128),
  tier: AlertTierSchema,
  kind: AlertKindSchema,
  decision: AlertDecisionSchema,
  decision_reason_json: AlertDecisionReasonSchema,
  created_at: EpochMsSchema,
});
export type Alert = z.infer<typeof AlertSchema>;

export const DeliverySchema = z.object({
  id: EntityIdSchema,
  alert_id: EntityIdSchema,
  destination_id: EntityIdSchema,
  idempotency_key: ContentHashSchema,
  state: DeliveryStateSchema,
  state_updated_at: EpochMsSchema,
  attempts: NonNegativeIntSchema,
  provider_message_id: z.string().min(1).max(128).nullable(),
  last_error: ErrorSummarySchema.nullable(),
  next_attempt_at: EpochMsSchema.nullable(),
  expires_at: EpochMsSchema,
  lang: LangSchema,
  dry_run: z.boolean(),
  suppressed_reason: DeliverySuppressionReasonSchema.nullable(),
  created_at: EpochMsSchema,
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const QuietHoursSchema = z.object({
  start: TimeOfDaySchema,
  end: TimeOfDaySchema,
  timezone: TimeZoneSchema,
});
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const SourceFiltersSchema = z.object({ hn: z.boolean(), changelog: z.boolean() });
export type SourceFilters = z.infer<typeof SourceFiltersSchema>;

export const DestinationSchema = z.object({
  id: EntityIdSchema,
  name: z.string().min(1).max(64),
  purpose: DestinationPurposeSchema,
  channel: DestinationChannelSchema,
  secret_ref: SecretRefSchema,
  lang: LangSchema,
  enabled: z.boolean(),
  dry_run: z.boolean(),
  min_tier: AlertTierSchema,
  daily_budget: NonNegativeIntSchema,
  source_filters: SourceFiltersSchema,
  quiet_hours: QuietHoursSchema.nullable(),
  created_at: EpochMsSchema,
  updated_at: EpochMsSchema,
});
export type Destination = z.infer<typeof DestinationSchema>;

const changelogTriageBudgetPrefix = "ai:triage:repo:";
const changelogSiteTriageBudgetPrefix = "ai:triage:site:";
const changelogSiteTriageBudgetPattern =
  /^ai:triage:site:(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;
const changelogTriageBudgetPattern =
  /^ai:triage:repo:(?=[a-z0-9-]{1,39}\/)[a-z0-9]+(?:-[a-z0-9]+)*\/(?!(?:\.{1,2}|[a-z0-9._-]*\.git)$)[a-z0-9._-]{1,100}$/;

export const BudgetScopeSchema = z
  .string()
  .refine(
    (scope) =>
      changelogTriageBudgetPattern.test(scope) ||
      changelogSiteTriageBudgetPattern.test(scope) ||
      /^(ai:(triage|deep|polish|translate)|notify:destination:[A-Za-z0-9_-]{1,64}|notify:source:(hn|changelog)|ops)$/.test(
        scope,
      ),
    "Invalid budget scope",
  );
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;

export function changelogTriageBudgetScope(repoRef: RepoRef): BudgetScope {
  const { owner, repo } = RepoRefSchema.parse(repoRef);
  return BudgetScopeSchema.parse(
    `${changelogTriageBudgetPrefix}${owner.toLowerCase()}/${repo.toLowerCase()}`,
  );
}

// A documentation changelog has no repository, so its triage budget is per site.
export function changelogSiteTriageBudgetScope(hostname: string): BudgetScope {
  return BudgetScopeSchema.parse(`${changelogSiteTriageBudgetPrefix}${hostname.toLowerCase()}`);
}

export const BudgetLedgerEntrySchema = z.object({
  day: DayKeySchema,
  scope: BudgetScopeSchema,
  used: NonNegativeIntSchema,
  limit: NonNegativeIntSchema,
});
export type BudgetLedgerEntry = z.infer<typeof BudgetLedgerEntrySchema>;

export const ConfigVersionSchema = z.object({
  version: PositiveIntSchema,
  config: AppConfigSchema,
  created_at: EpochMsSchema,
  created_by: z.string().min(1).max(128),
});
export type ConfigVersion = z.infer<typeof ConfigVersionSchema>;

export const AuditLogEntrySchema = z.object({
  id: EntityIdSchema,
  actor: z.string().min(1).max(128),
  action: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/),
  target: z.string().min(1).max(255),
  detail_json: JsonObjectSchema,
  created_at: EpochMsSchema,
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

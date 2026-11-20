// Wire-form examples of every contract schema, written as plain JSON values the way they appear on
// a queue, in a row, or in a config snapshot.

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const T0 = 1_795_000_000_000;

const models = {
  triage: { provider: "fake", model: "fake-small", fallbacks: [], max_output_tokens: 800 },
  deep: {
    provider: "fake",
    model: "fake-large",
    fallbacks: ["fake-large-b"],
    max_output_tokens: 4000,
  },
  translate: { provider: "fake", model: "fake-small", fallbacks: [], max_output_tokens: 2000 },
};

const hnSourceConfig = { kind: "hn_top", top_n: 60, track_limit: 90 };
const githubSourceConfig = {
  kind: "github_repo",
  owner: "example-org",
  repo: "example-cli",
  strategy: "release_first",
  changelog_path: "CHANGELOG.md",
};
const hnCursor = { kind: "hn_top" };
const githubCursor = {
  kind: "github_repo",
  releases_etag: 'W/"abc123"',
  tags_etag: null,
  changelog_sha: null,
  known_versions: ["1.2.3", "1.2.2"],
};

const hnSource = {
  id: "src_hn_top",
  key: "hn:top",
  kind: "hn_top",
  config_json: hnSourceConfig,
  poll_interval_sec: 600,
  next_poll_at: T0,
  cursor_json: hnCursor,
  consecutive_failures: 0,
  status: "active",
  last_success_at: null,
  created_at: T0,
  updated_at: T0,
};
const githubSource = {
  ...hnSource,
  id: "src_gh_example",
  key: "github:example-org/example-cli",
  kind: "github_repo",
  config_json: githubSourceConfig,
  cursor_json: githubCursor,
  consecutive_failures: 3,
  status: "degraded",
  last_success_at: T0 - 3_600_000,
};

const hnFeatures = {
  vp: 142,
  vc: 61,
  acc: 12.5,
  climb: 32,
  points: 180,
  comments: 75,
  rank: 6,
  age_h: 2.5,
};
const hnPercentiles = { vp: 0.97, vc: 0.95, climb: 0.9, acc: 0.8, points: 0.7 };
const hnScore = {
  kind: "hn",
  heat: 91.5,
  level: "H2",
  features: hnFeatures,
  percentiles: hnPercentiles,
  gates: ["G1", "G2"],
  cold_start: false,
  computed_at: T0,
};
const changelogSignalHit = {
  signal: "new_surface",
  points: 30,
  evidence: ["Added `--sandbox` flag"],
};
const changelogScore = {
  kind: "changelog",
  prior: 55,
  signals: [changelogSignalHit, { signal: "breaking", points: 25, evidence: [] }],
  computed_at: T0,
};

const hnItem = {
  id: "item_hn_12345",
  source_id: "src_hn_top",
  external_key: "hn:12345",
  kind: "hn",
  url: "https://example.com/post",
  title: "Show HN: An example",
  published_at: T0 - 7_200_000,
  content_hash: null,
  revision: 0,
  state: "tracking",
  state_updated_at: T0,
  score_json: hnScore,
  tier: "H2",
  cluster_id: null,
  attempts: 0,
  next_attempt_at: null,
  first_seen_at: T0 - 3_600_000,
  last_seen_at: T0,
};
const changelogItem = {
  ...hnItem,
  id: "item_gh_1",
  source_id: "src_gh_example",
  external_key: "gh:example-org/example-cli@1.2.3",
  kind: "changelog",
  url: "https://github.com/example-org/example-cli/releases/tag/v1.2.3",
  title: "example-cli 1.2.3",
  content_hash: HASH_A,
  revision: 2,
  state: "candidate",
  score_json: changelogScore,
  tier: null,
  cluster_id: "cluster_1",
  attempts: 1,
  next_attempt_at: T0 + 60_000,
};

const usage = { input_tokens: 5200, output_tokens: 410, cost_usd: 0.0123 };
const analysisKey = {
  item_id: "item_gh_1",
  stage: "deep",
  input_hash: HASH_A,
  prompt_version: "deep-v1",
  lang: "en",
};
const citation = { locator: "comment:424242", quote: "Added `--sandbox` flag." };
const deepAssessment = {
  confidence: 0.85,
  why_now: "The new flag changes isolation defaults.",
  summary: "  Review sandbox settings before upgrading.\n",
  key_points: ["Sandbox mode is opt-in."],
  engineering_implications: ["Test CI jobs with the new flag."],
  caveats: [],
  citations: [citation],
};
const analysis = {
  ...analysisKey,
  id: "an_1",
  model: "fake-large",
  config_version: 3,
  status: "succeeded",
  output_json: { summary: "text", importance: 4, key_points: [{ text: "a", comment_id: null }] },
  r2_key: `sha256/${HASH_B}`,
  usage_json: usage,
  error_code: null,
  created_at: T0,
  updated_at: T0 + 5000,
};
const failedAnalysis = {
  ...analysis,
  id: "an_2",
  status: "failed",
  output_json: null,
  r2_key: null,
  usage_json: null,
  error_code: "LLM_OUTPUT_INVALID",
};

const decisionReason = {
  why_now: "Score velocity 142/h (P97 for its age), rank 38 to 6 in 30 minutes",
  blocked_by: [],
  importance: 4,
  impact: null,
  heat_level: "H2",
  prior: null,
};
const alert = {
  id: "al_1",
  alert_key: HASH_A,
  item_id: "item_hn_12345",
  analysis_id: "an_1",
  cluster_id: "cluster_1",
  tier: 2,
  kind: "new",
  decision: "send",
  decision_reason_json: decisionReason,
  created_at: T0,
};
const feedOnlyAlert = {
  ...alert,
  id: "al_2",
  alert_key: HASH_B,
  tier: 1,
  kind: "update",
  decision: "feed_only",
  decision_reason_json: {
    ...decisionReason,
    blocked_by: ["budget_exhausted", "quiet_hours"],
    importance: null,
    impact: 2,
    heat_level: null,
    prior: 45,
  },
};

const errorSummary = {
  code: "UPSTREAM_RATE_LIMITED",
  kind: "retryable",
  message: "429 from webhook",
};
const delivery = {
  id: "dl_1",
  alert_id: "al_1",
  destination_id: "dest_slack_main",
  idempotency_key: HASH_B,
  state: "failed_retryable",
  state_updated_at: T0,
  attempts: 1,
  provider_message_id: null,
  last_error: errorSummary,
  next_attempt_at: T0 + 30_000,
  expires_at: T0 + 21_600_000,
  lang: "ja",
  dry_run: true,
  suppressed_reason: null,
  created_at: T0,
};
const suppressedDelivery = {
  ...delivery,
  id: "dl_2",
  state: "suppressed",
  attempts: 0,
  last_error: null,
  next_attempt_at: null,
  suppressed_reason: "budget",
};

const quietHours = { start: "23:00", end: "07:00", timezone: "Asia/Tokyo" };
const sourceFilters = { hn: true, changelog: false };
const destinationSummary = {
  id: "dest_slack_main",
  name: "slack-main",
  purpose: "alerts",
  channel: "slack",
  lang: "ja",
  enabled: true,
  dry_run: true,
  min_tier: 1,
  daily_budget: 8,
  source_filters: sourceFilters,
  quiet_hours: quietHours,
  created_at: T0,
  updated_at: T0,
};
const destination = { ...destinationSummary, secret_ref: "SLACK_WEBHOOK_MAIN" };
const opsDestination = {
  ...destination,
  id: "dest_discord_ops",
  name: "discord-ops",
  purpose: "ops",
  channel: "discord",
  secret_ref: "DISCORD_WEBHOOK_OPS",
  lang: "en",
  quiet_hours: null,
};

const alertPoint = {
  text: "Adds a sandbox mode",
  evidence_quote: "Added `--sandbox` flag",
  comment_id: null,
};
const alertTitle = { original: "example-cli 1.2.3", translated: "example-cli 1.2.3 リリース" };
const alertLinks = {
  source: "https://github.com/example-org/example-cli/releases/tag/v1.2.3",
  discussion: "https://news.ycombinator.com/item?id=12345",
  detail: "https://ai-moves.example.com/items/item_gh_1",
};
const alertTranslation = { machine_translated: true, fell_back_to_english: false };
const alertDoc = {
  v: 1,
  alert_id: "al_1",
  kind: "new",
  item_kind: "changelog",
  tier: 3,
  lang: "ja",
  source_label: "example-org/example-cli",
  title: alertTitle,
  why_now: "2 new config keys, 1 breaking change",
  summary: "Release 1.2.3 adds a sandbox mode.",
  key_points: [
    alertPoint,
    { text: "Discussed widely", evidence_quote: null, comment_id: "424242" },
  ],
  engineering_implications: ["Review CI flags before upgrading"],
  caveats: [],
  links: alertLinks,
  translation: alertTranslation,
  generated_at: T0,
};

const watchlistEntry = {
  owner: "example-org",
  repo: "example-cli",
  strategy: "changelog_file",
  changelog_path: "docs/CHANGELOG.md",
  poll_interval_sec: 900,
};
const appConfigMinimal = { models };
const appConfigCustom = {
  models,
  ai: { enabled: false, deep_per_day: 5 },
  delivery: { force_dry_run: false, quiet_hours: { start: "22:00" } },
  watchlist: [watchlistEntry, { owner: "other", repo: "tool" }],
};

const story = {
  id: 12345,
  type: "story",
  title: "Show HN: An example",
  url: "https://example.com/post",
  text: null,
  author: "someone",
  points: 180,
  comments: 75,
  published_at: T0,
  deleted: false,
  dead: false,
};
const comment = {
  id: 424242,
  parent_id: 12345,
  depth: 0,
  author: "commenter",
  text: "Interesting",
  published_at: T0,
};
const release = {
  tag: "v1.2.3",
  name: "1.2.3",
  body: "## Changes\n- Added `--sandbox` flag",
  prerelease: false,
  draft: false,
  published_at: T0,
  url: "https://github.com/example-org/example-cli/releases/tag/v1.2.3",
};

const logRecord = {
  ts: T0,
  level: "error",
  event: "deliver.failed",
  component: "delivery",
  trace_id: "trace_1",
  source_id: "src_hn_top",
  item_id: "item_hn_12345",
  stage: "deliver",
  duration_ms: 12.5,
  err: errorSummary,
  attrs: { attempt: 2, destination: "slack-main" },
};

const pollJob = {
  v: 1,
  type: "poll",
  source_id: "src_hn_top",
  tick_bucket: 2_991_666,
  trace_id: "trace_1",
};
const triageJob = { v: 1, type: "triage", item_id: "item_hn_12345", trace_id: "trace_1" };
const deepJob = { v: 1, type: "deep", item_id: "item_hn_12345", trace_id: "trace_1" };
const deliverJob = { v: 1, type: "deliver", delivery_id: "dl_1", trace_id: "trace_1" };

export const JOB_SAMPLES = { pollJob, triageJob, deepJob, deliverJob } as const;

export const VALID_SAMPLES: Readonly<Record<string, readonly unknown[]>> = {
  EpochMsSchema: [0, T0],
  EntityIdSchema: ["item_hn_12345", "019328d4-7c00-7000-8000-000000000000"],
  TraceIdSchema: ["trace_1"],
  ContentHashSchema: [HASH_A],
  HttpUrlSchema: ["http://example.com/a", "https://example.com/a?b=1"],
  HttpsUrlSchema: ["https://example.com/a"],
  DayKeySchema: ["2026-11-20"],
  TimeOfDaySchema: ["00:00", "23:59"],
  TimeZoneSchema: ["Asia/Tokyo"],
  SecretRefSchema: ["SLACK_WEBHOOK_MAIN"],
  JsonValueSchema: [null, 1, "a", [1, { b: [true] }]],
  JsonObjectSchema: [{}, { a: { b: [1, null] } }],
  UnitIntervalSchema: [0, 0.5, 1],
  NonNegativeIntSchema: [0, 7],
  PositiveIntSchema: [1],
  AlertTierSchema: [1, 2, 3],
  ErrorCodeSchema: ["INTERNAL", "OUTCOME_UNKNOWN"],
  ErrorSummarySchema: [errorSummary],
  LogRecordSchema: [
    logRecord,
    { ts: T0, level: "info", event: "tick.start", component: "ingestion" },
  ],
  HnFeaturesSchema: [hnFeatures, { ...hnFeatures, rank: null }],
  HnPercentilesSchema: [hnPercentiles],
  HnScoreSchema: [
    hnScore,
    { ...hnScore, level: null, percentiles: null, gates: [], cold_start: true },
  ],
  ChangelogSignalHitSchema: [changelogSignalHit],
  ChangelogScoreSchema: [changelogScore],
  ItemScoreSchema: [hnScore, changelogScore],
  RepoRefSchema: [{ owner: "example-org", repo: "example-cli" }],
  HnTopSourceConfigSchema: [hnSourceConfig],
  GitHubRepoSourceConfigSchema: [githubSourceConfig],
  SourceConfigSchema: [hnSourceConfig, githubSourceConfig],
  HnTopSourceCursorSchema: [hnCursor],
  GitHubRepoSourceCursorSchema: [githubCursor],
  SourceCursorSchema: [hnCursor, githubCursor],
  SourceSchema: [hnSource, githubSource],
  ItemSchema: [hnItem, changelogItem],
  ItemSnapshotSchema: [
    { item_id: "item_hn_12345", sampled_at: T0, rank: 6, points: 180, comments: 75 },
    { item_id: "item_hn_12345", sampled_at: T0, rank: null, points: 0, comments: 0 },
  ],
  ItemRevisionSchema: [
    {
      item_id: "item_gh_1",
      content_hash: HASH_A,
      origin: "release",
      r2_key: `sha256/${HASH_A}`,
      observed_at: T0,
    },
  ],
  LlmUsageSchema: [usage, { ...usage, cost_usd: null }],
  CitationSchema: [citation, { locator: "CHANGELOG.md#v123", quote: "• Added sandbox mode" }],
  TriageAssessmentSchema: [
    { kind: "hn", decision: "pass", confidence: 1 },
    { kind: "changelog", decision: "reject", confidence: 0, rejection_reason: "No user change" },
  ],
  HnDeepAssessmentSchema: [{ ...deepAssessment, kind: "hn", importance: 5 }],
  ChangelogDeepAssessmentSchema: [{ ...deepAssessment, kind: "changelog", impact: 0 }],
  AnalysisKeySchema: [analysisKey],
  AnalysisSchema: [analysis, failedAnalysis],
  AlertDecisionReasonSchema: [decisionReason],
  AlertSchema: [alert, feedOnlyAlert],
  DeliverySchema: [delivery, suppressedDelivery],
  QuietHoursSchema: [quietHours],
  SourceFiltersSchema: [sourceFilters],
  DestinationSchema: [destination, opsDestination],
  StorageLimitSchema: [1, 100],
  FeedQuerySchema: [{ limit: 10 }, { limit: 100, before: { at: T0, id: hnItem.id } }],
  AlertFeedQuerySchema: [{ limit: 2, itemId: alert.item_id, before: { at: T0, id: alert.id } }],
  DestinationPatchSchema: [{ enabled: false, min_tier: 3, quiet_hours: null }],
  DestinationSummarySchema: [destinationSummary],
  AdminChangeSchema: [{ id: "au_1", actor: "admin@example.com", at: T0 }],
  BudgetRequestSchema: [
    { workId: "attempt_1", day: "2026-11-20", scope: "ai:deep", amount: 1, limit: 20 },
  ],
  BudgetScopeSchema: ["ai:triage", "notify:destination:dest_slack_main", "notify:source:hn", "ops"],
  BudgetLedgerEntrySchema: [{ day: "2026-11-20", scope: "ai:deep", used: 3, limit: 20 }],
  ConfigVersionSchema: [
    { version: 3, config: appConfigCustom, created_at: T0, created_by: "admin@example.com" },
  ],
  AuditLogEntrySchema: [
    {
      id: "au_1",
      actor: "admin@example.com",
      action: "config.publish",
      target: "config:3",
      detail_json: { previous: 2 },
      created_at: T0,
    },
  ],
  PollJobV1Schema: [pollJob],
  TriageJobV1Schema: [triageJob],
  DeepJobV1Schema: [deepJob],
  DeliverJobV1Schema: [deliverJob],
  PollJobSchema: [pollJob],
  TriageJobSchema: [triageJob],
  DeepJobSchema: [deepJob],
  DeliverJobSchema: [deliverJob],
  JobSchema: [pollJob, triageJob, deepJob, deliverJob],
  TickEventSchema: [{ scheduled_time: T0, cron: "*/5 * * * *" }],
  AlertTextSchema: ["plain text"],
  AlertTitleSchema: [alertTitle, { original: "Title", translated: null }],
  AlertPointSchema: [alertPoint],
  AlertLinksSchema: [alertLinks, { ...alertLinks, discussion: null }],
  AlertTranslationSchema: [alertTranslation],
  AlertDocSchema: [alertDoc],
  ModelConfigSchema: [models.deep, { provider: "fake", model: "m", max_output_tokens: 1 }],
  ModelsConfigSchema: [models],
  AiConfigSchema: [{}, { enabled: false }],
  ProfileConfigSchema: [{}, { topics: ["databases"] }],
  HnHeatWeightsSchema: [{}, { vp: 0.2, vc: 0.2, climb: 0.2, acc: 0.2, points: 0.2 }],
  HnConfigSchema: [{}, { top_n: 30, gate_burst: { min_points: 50 } }],
  ChangelogConfigSchema: [{}, { prior_points: { breaking: 40 } }],
  PushConfigSchema: [{}, { hn: { min_importance: 5 } }],
  DeliveryConfigSchema: [{}, { paused: true, expiry_hours: { hn: 3 } }],
  RetryConfigSchema: [{}, { deliver: { max_attempts: 2, backoff_seconds: [10] } }],
  LeaseConfigSchema: [{}, { deep_minutes: 20 }],
  TimeoutConfigSchema: [{}, { llm_ms: 30_000 }],
  WebFetchConfigSchema: [{}, { denied_domains: ["example.invalid"] }],
  HealthConfigSchema: [{}],
  WatchlistEntrySchema: [watchlistEntry, { owner: "other", repo: "tool" }],
  AppConfigSchema: [appConfigMinimal, appConfigCustom],
  RuntimeEnvSchema: [{ ENVIRONMENT: "local" }, { ENVIRONMENT: "production", LOG_LEVEL: "warn" }],
  HnStorySchema: [story, { ...story, type: "job", url: null, text: "We are hiring", author: null }],
  HnCommentSchema: [comment],
  HnCommentTreeSchema: [
    {
      story_id: 12345,
      comments: [comment, { ...comment, id: 424243, parent_id: 424242, depth: 1 }],
    },
  ],
  GitHubReleaseSchema: [
    release,
    { ...release, name: null, body: null, published_at: null, prerelease: true },
  ],
  GitHubTagSchema: [{ name: "v1.2.3", commit_sha: "0123456789abcdef0123456789abcdef01234567" }],
  GitHubFileSchema: [{ path: "CHANGELOG.md", sha: "abc123", text: "# Changelog" }],
  GitHubCompareSchema: [
    {
      base: "v1.2.2",
      head: "v1.2.3",
      commit_messages: ["fix: handle empty notes"],
      url: "https://github.com/example-org/example-cli/compare/v1.2.2...v1.2.3",
    },
  ],
  WebDocumentSchema: [
    {
      requested_url: "https://example.com/post",
      final_url: "https://www.example.com/post",
      content_type: "text/html",
      text: "Body",
      truncated: false,
      content_hash: HASH_A,
    },
  ],
  NotifyReceiptSchema: [{ provider_message_id: "1234567890" }, { provider_message_id: null }],
};

export const SAMPLE = {
  hnSource,
  githubSource,
  hnItem,
  destination,
  alertDoc,
  delivery,
  models,
  pollJob,
} as const;

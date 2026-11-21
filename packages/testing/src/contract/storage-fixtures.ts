import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import { AppConfigSchema } from "@ai-moves/contracts/config";
import type { Alert, Analysis, Delivery, Destination } from "@ai-moves/contracts/entities";
import type { NewSource, ObservedItem } from "@ai-moves/contracts/ports/storage";

export const STORAGE_TEST_TIME = 1_795_000_000_000;
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);

const model = { provider: "fake", model: "fixture", max_output_tokens: 500 };
export const storageConfig = AppConfigSchema.parse({
  models: { triage: model, deep: model, translate: model },
});

export const githubSource: NewSource = {
  id: "src_cli",
  key: "github:example/cli",
  kind: "github_repo",
  config_json: {
    kind: "github_repo",
    owner: "example",
    repo: "cli",
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
  poll_interval_sec: 600,
  next_poll_at: STORAGE_TEST_TIME,
  created_at: STORAGE_TEST_TIME,
  updated_at: STORAGE_TEST_TIME,
};

export const observedItem: ObservedItem = {
  id: "item_cli_v1",
  source_id: githubSource.id,
  external_key: "gh:example/cli@1.0.0",
  kind: "changelog",
  url: "https://example.test/cli/v1",
  title: "Example CLI v1",
  published_at: STORAGE_TEST_TIME - 10,
  observed_at: STORAGE_TEST_TIME,
  state: "candidate",
};

export const pendingAnalysis: Analysis = {
  id: "analysis_1",
  item_id: observedItem.id,
  stage: "deep",
  input_hash: HASH_A,
  prompt_version: "deep-v1",
  lang: "en",
  model: "fixture",
  config_version: 1,
  status: "pending",
  output_json: null,
  r2_key: null,
  usage_json: null,
  error_code: null,
  created_at: STORAGE_TEST_TIME,
  updated_at: STORAGE_TEST_TIME,
};

export const alertFixture: Alert = {
  id: "alert_1",
  alert_key: HASH_A,
  item_id: observedItem.id,
  analysis_id: pendingAnalysis.id,
  cluster_id: "cluster_cli",
  tier: 2,
  kind: "new",
  decision: "send",
  decision_reason_json: {
    why_now: "A new command changes the workflow.",
    blocked_by: [],
    importance: null,
    impact: 2,
    heat_level: null,
    prior: 55,
  },
  created_at: STORAGE_TEST_TIME,
};

export function documentFixture(alert: Alert, lang: AlertDoc["lang"] = "en"): AlertDoc {
  return {
    v: 1,
    alert_id: alert.id,
    kind: alert.kind,
    item_kind: "changelog",
    tier: alert.tier,
    lang,
    source_label: "Example CLI",
    title: {
      original: "Example CLI v1",
      translated: lang === "ja" ? "Example CLI v1 の更新" : null,
    },
    why_now: alert.decision_reason_json.why_now,
    summary: "Review the changed default.",
    key_points: [
      { text: "The default changed.", evidence_quote: "Default: off", comment_id: null },
    ],
    engineering_implications: ["Review sandbox settings."],
    caveats: [],
    links: {
      source: "https://example.test/cli/v1",
      discussion: null,
      detail: "https://example.test/feed/cli",
    },
    translation: { machine_translated: lang !== "en", fell_back_to_english: false },
    generated_at: alert.created_at,
  };
}

export function destinationFixture(index: number): Destination {
  return {
    id: `destination_${index}`,
    name: `test-destination-${index}`,
    purpose: "alerts",
    channel: "slack",
    secret_ref: "TEST_WEBHOOK",
    lang: "en",
    enabled: true,
    dry_run: true,
    min_tier: 1,
    daily_budget: 10,
    source_filters: { hn: true, changelog: true },
    quiet_hours: null,
    created_at: STORAGE_TEST_TIME,
    updated_at: STORAGE_TEST_TIME,
  };
}

export function deliveryFixture(alert: Alert, index: number): Delivery {
  const destinationId = `destination_${index}`;
  return {
    id: `${alert.id}_${destinationId}`,
    alert_id: alert.id,
    destination_id: destinationId,
    idempotency_key: `${alert.alert_key.slice(0, 62)}${index.toString(16).padStart(2, "0")}`,
    state: "pending",
    state_updated_at: STORAGE_TEST_TIME,
    attempts: 0,
    provider_message_id: null,
    last_error: null,
    next_attempt_at: STORAGE_TEST_TIME,
    expires_at: STORAGE_TEST_TIME + 3_600_000,
    lang: "en",
    dry_run: true,
    suppressed_reason: null,
    created_at: STORAGE_TEST_TIME,
  };
}

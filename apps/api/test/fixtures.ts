import { AppConfigSchema } from "@ai-moves/contracts/config";
import type { Alert, Delivery, Destination } from "@ai-moves/contracts/entities";
import { createD1Storage } from "@ai-moves/storage/d1";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";

const team = "https://fixture.cloudflareaccess.com";
const audience = "synthetic-signal-desk";
const keyId = "fixture-key";
export const operator = "operator-subject";

export async function testAccess(): Promise<{
  bindings: Record<string, string>;
  sign: (extra?: JWTPayload, options?: { wrongKey?: boolean; kid?: string }) => Promise<string>;
}> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const { privateKey: wrongKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: keyId, alg: "RS256", use: "sig" };
  return {
    bindings: {
      ACCESS_ISSUER: team,
      ACCESS_AUDIENCE: audience,
      ACCESS_JWKS: JSON.stringify({ keys: [jwk] }),
      ACCESS_ADMIN_SUBJECTS: JSON.stringify([operator]),
    },
    sign: async (extra = {}, options = {}) =>
      new SignJWT({
        type: "app",
        iss: team,
        aud: [audience],
        sub: operator,
        exp: 4_102_444_800,
        ...extra,
      })
        .setProtectedHeader({ alg: "RS256", kid: options.kid ?? keyId })
        .sign(options.wrongKey ? wrongKey : privateKey),
  };
}

export const fixtureInstant = 1_795_000_000_000;
export const secretReferenceFixture = "TEST_NOTIFICATION_REFERENCE";
export const rawModelFixture = "synthetic raw model output";
const model = { provider: "openrouter", model: "fixture-model", max_output_tokens: 500 };
export const fixtureConfig = AppConfigSchema.parse({
  models: { triage: model, deep: model, translate: model },
});
const destination = {
  id: "desk_slack",
  name: "Engineering updates",
  purpose: "alerts",
  channel: "slack",
  lang: "en",
  enabled: true,
  dry_run: true,
  min_tier: 2,
  daily_budget: 8,
  source_filters: { hn: true, changelog: true },
  quiet_hours: null,
  created_at: fixtureInstant,
  updated_at: fixtureInstant,
  secret_ref: secretReferenceFixture,
} satisfies Destination;

export async function seedDesk(database: D1Database, olderCount = 0): Promise<void> {
  const repos = createD1Storage(database);
  await repos.config.publish(fixtureConfig, "fixture", fixtureInstant);
  await repos.sources.upsert({
    id: "source_hn",
    key: "hn:top",
    kind: "hn_top",
    config_json: { kind: "hn_top", top_n: 60, track_limit: 90 },
    poll_interval_sec: 600,
    cursor_json: { kind: "hn_top" },
    next_poll_at: fixtureInstant,
    created_at: fixtureInstant,
    updated_at: fixtureInstant,
  });
  for (const [id, title, state, age] of [
    ["signal_z", "Orbit CLI adds isolated tool sessions", "alerted", 0],
    ["signal_a", "A practical guide to evaluating agent traces", "feed_only", 0],
    ["signal_hidden", "Unreviewed candidate", "candidate", 0],
    ...Array.from(
      { length: olderCount },
      (_, index) =>
        [`older_${index}`, `Engineering note ${index + 1}`, "feed_only", index + 1] as const,
    ),
  ] as const) {
    await repos.items.upsertObserved({
      id,
      source_id: "source_hn",
      external_key: `hn:${id}`,
      kind: "hn",
      url: "https://example.test/orbit",
      title,
      published_at: null,
      observed_at: fixtureInstant - age * 86_400_000,
      state,
    });
  }
  await repos.destinations.upsert(destination);
  await repos.analyses.insertIfAbsent({
    id: "analysis_private",
    item_id: "signal_z",
    stage: "deep",
    input_hash: "a".repeat(64),
    prompt_version: "fixture-v1",
    lang: "en",
    model: "fixture-model",
    config_version: 1,
    status: "succeeded",
    output_json: { internal: rawModelFixture },
    r2_key: "private-model-blob",
    usage_json: null,
    error_code: null,
    created_at: fixtureInstant,
    updated_at: fixtureInstant,
  });
  const alert = {
    id: "alert_orbit",
    alert_key: "b".repeat(64),
    item_id: "signal_z",
    analysis_id: "analysis_private",
    cluster_id: "orbit",
    tier: 2,
    kind: "new",
    decision: "send",
    decision_reason_json: {
      why_now: "internal reason fixture",
      blocked_by: [],
      importance: 4,
      impact: null,
      prior: null,
      heat_level: "H2",
    },
    created_at: fixtureInstant,
  } satisfies Alert;
  const delivery = {
    id: "delivery_orbit",
    alert_id: alert.id,
    destination_id: destination.id,
    idempotency_key: "c".repeat(64),
    state: "sent",
    state_updated_at: fixtureInstant,
    attempts: 1,
    provider_message_id: "private-provider-message",
    last_error: null,
    next_attempt_at: null,
    expires_at: fixtureInstant + 3600_000,
    lang: "en",
    dry_run: true,
    suppressed_reason: null,
    created_at: fixtureInstant,
  } satisfies Delivery;
  await repos.alerts.insertWithDeliveries(
    alert,
    [delivery],
    [
      {
        v: 1,
        alert_id: alert.id,
        item_kind: "hn",
        kind: alert.kind,
        tier: alert.tier,
        lang: "en",
        source_label: "Hacker News",
        title: { original: "Orbit CLI adds isolated tool sessions", translated: null },
        why_now: "A new release changes local tool isolation.",
        summary: "Orbit CLI can keep tools in separate sessions without changing a shared shell.",
        key_points: [
          {
            text: "Tools no longer have to share a shell.",
            evidence_quote: "Each tool starts its own session.",
            comment_id: null,
          },
        ],
        engineering_implications: ["Review assumptions about shell state in scripted tool calls."],
        caveats: [],
        links: {
          source: "https://example.test/orbit",
          discussion: null,
          detail: "https://desk.example.test/items/signal_z",
        },
        translation: { machine_translated: false, fell_back_to_english: false },
        generated_at: fixtureInstant,
      },
    ],
  );
}

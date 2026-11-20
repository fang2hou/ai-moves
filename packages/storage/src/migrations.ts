import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

export interface StorageMigration {
  readonly id: string;
  readonly statements: readonly string[];
}

export const STORAGE_MIGRATIONS: readonly StorageMigration[] = [
  {
    id: "0001_expand_storage",
    statements: [
      `CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        config_json TEXT NOT NULL,
        poll_interval_sec INTEGER NOT NULL,
        next_poll_at INTEGER NOT NULL,
        cursor_json TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_success_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX sources_due_idx ON sources(status, next_poll_at, id)`,
      `CREATE TABLE items (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id),
        external_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        url TEXT,
        title TEXT NOT NULL,
        published_at INTEGER,
        content_hash TEXT,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        state_updated_at INTEGER NOT NULL,
        score_json TEXT,
        tier TEXT,
        cluster_id TEXT,
        attempts INTEGER NOT NULL,
        next_attempt_at INTEGER,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )`,
      `CREATE INDEX items_source_state_idx ON items(source_id, state, id)`,
      `CREATE INDEX items_stale_idx ON items(state, state_updated_at, id)`,
      `CREATE TABLE item_snapshots (
        item_id TEXT NOT NULL REFERENCES items(id),
        sampled_at INTEGER NOT NULL,
        rank INTEGER,
        points INTEGER NOT NULL,
        comments INTEGER NOT NULL,
        PRIMARY KEY (item_id, sampled_at)
      )`,
      `CREATE TABLE item_revisions (
        item_id TEXT NOT NULL REFERENCES items(id),
        content_hash TEXT NOT NULL,
        origin TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        PRIMARY KEY (item_id, content_hash)
      )`,
      `CREATE TABLE config_versions (
        version INTEGER PRIMARY KEY,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL
      )`,
      `CREATE TABLE analyses (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id),
        stage TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        lang TEXT NOT NULL,
        model TEXT NOT NULL,
        config_version INTEGER NOT NULL REFERENCES config_versions(version),
        status TEXT NOT NULL,
        output_json TEXT,
        r2_key TEXT,
        usage_json TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (item_id, stage, input_hash, prompt_version, lang)
      )`,
      `CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        alert_key TEXT NOT NULL UNIQUE,
        item_id TEXT NOT NULL REFERENCES items(id),
        analysis_id TEXT NOT NULL REFERENCES analyses(id),
        cluster_id TEXT NOT NULL,
        tier INTEGER NOT NULL,
        kind TEXT NOT NULL,
        decision TEXT NOT NULL,
        decision_reason_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE destinations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL,
        channel TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        lang TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        dry_run INTEGER NOT NULL,
        min_tier INTEGER NOT NULL,
        daily_budget INTEGER NOT NULL,
        source_filters_json TEXT NOT NULL,
        quiet_hours_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        alert_id TEXT NOT NULL REFERENCES alerts(id),
        destination_id TEXT NOT NULL REFERENCES destinations(id),
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        state_updated_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        provider_message_id TEXT,
        last_error_json TEXT,
        next_attempt_at INTEGER,
        expires_at INTEGER NOT NULL,
        lang TEXT NOT NULL,
        dry_run INTEGER NOT NULL,
        suppressed_reason TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX deliveries_due_idx ON deliveries(state, next_attempt_at, id)`,
      `CREATE INDEX deliveries_stale_idx ON deliveries(state, state_updated_at, id)`,
      `CREATE TABLE budget_ledger (
        day TEXT NOT NULL,
        scope TEXT NOT NULL,
        used INTEGER NOT NULL,
        limit_value INTEGER NOT NULL,
        PRIMARY KEY (day, scope)
      )`,
      `CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX audit_recent_idx ON audit_log(created_at DESC, id DESC)`,
    ],
  },
];

function prepareStatements(
  database: D1Database,
  migration: StorageMigration,
): D1PreparedStatement[] {
  return [
    ...migration.statements.map((statement) => database.prepare(statement)),
    database.prepare("INSERT INTO storage_migrations (id) VALUES (?)").bind(migration.id),
  ];
}

export async function applyStorageMigrations(database: D1Database): Promise<void> {
  await database
    .prepare(
      "CREATE TABLE IF NOT EXISTS storage_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    )
    .run();

  for (const migration of STORAGE_MIGRATIONS) {
    const applied = await database
      .prepare("SELECT id FROM storage_migrations WHERE id = ?")
      .bind(migration.id)
      .first<{ id: string }>();
    if (applied === null) {
      await database.batch(prepareStatements(database, migration));
    }
  }
}

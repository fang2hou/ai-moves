// Prints the seed rows (see seed.ts) as SQL for a fresh D1 database. Applied with
// `wrangler d1 execute ai-moves --remote --file`.
import { systemClock } from "@ai-moves/kernel/clock";

import { buildSeed, seedOptionsFromEnv } from "./seed.ts";

const now = systemClock.now();
const { config, sources, destination } = buildSeed(seedOptionsFromEnv(now));

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const json = (value: unknown): string => quote(JSON.stringify(value));
const flag = (value: boolean): number => (value ? 1 : 0);
const lines: string[] = [];

lines.push(
  `INSERT OR REPLACE INTO config_versions (version, config_json, created_at, created_by) VALUES (1, ${json(config)}, ${now}, 'deploy');`,
);
for (const source of sources) {
  lines.push(
    `INSERT OR REPLACE INTO sources (id, key, kind, config_json, poll_interval_sec, next_poll_at, cursor_json, consecutive_failures, status, last_success_at, created_at, updated_at) VALUES (${quote(source.id)}, ${quote(source.key)}, ${quote(source.kind)}, ${json(source.config_json)}, ${source.poll_interval_sec}, ${source.next_poll_at}, ${json(source.cursor_json)}, 0, 'active', NULL, ${source.created_at}, ${source.updated_at});`,
  );
}
lines.push(
  `INSERT OR REPLACE INTO destinations (id, name, purpose, channel, secret_ref, lang, enabled, dry_run, min_tier, daily_budget, source_filters_json, quiet_hours_json, created_at, updated_at) VALUES (${quote(destination.id)}, ${quote(destination.name)}, ${quote(destination.purpose)}, ${quote(destination.channel)}, ${quote(destination.secret_ref)}, ${quote(destination.lang)}, ${flag(destination.enabled)}, ${flag(destination.dry_run)}, ${destination.min_tier}, 0, ${json(destination.source_filters)}, ${destination.quiet_hours === null ? "NULL" : json(destination.quiet_hours)}, ${destination.created_at}, ${destination.updated_at});`,
);

console.log(lines.join("\n"));

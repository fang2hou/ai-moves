// Prints the storage schema as one SQL script, for applying to a remote D1 with
// `wrangler d1 execute --file`. The Worker applies the same list itself when it
// runs against a local database.
import { STORAGE_MIGRATIONS } from "@ai-moves/storage/migrations";

const lines = [
  "CREATE TABLE IF NOT EXISTS storage_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);",
];
for (const migration of STORAGE_MIGRATIONS) {
  for (const statement of migration.statements)
    lines.push(`${statement.trim().replace(/;$/u, "")};`);
  lines.push(`INSERT OR IGNORE INTO storage_migrations (id) VALUES ('${migration.id}');`);
}
console.log(lines.join("\n"));

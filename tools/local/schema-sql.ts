// Prints the storage schema as one SQL script, for applying to a remote D1 with
// `wrangler d1 execute --file`. The Worker applies the same list itself when it
// runs against a local database.
//
// `--applied <file>` narrows the output to the migrations that file does not
// list. It holds the ids recorded in the database's `storage_migrations` table,
// either as a JSON array or as `wrangler d1 execute --json` prints them.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { STORAGE_MIGRATIONS } from "@ai-moves/storage/migrations";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function readAppliedIds(path: string): Set<string> {
  const text = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path} does not hold JSON.`);
  }
  if (!Array.isArray(value)) throw new Error(`${path} does not hold a JSON array.`);

  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string") ids.add(entry);
    // A query that failed must not read as a database without migrations.
    else if (isRecord(entry) && entry.success === true && Array.isArray(entry.results)) {
      for (const row of entry.results)
        if (isRecord(row) && typeof row.id === "string") ids.add(row.id);
    } else throw new Error(`${path} holds neither migration ids nor wrangler results.`);
  }
  return ids;
}

// `CREATE` is made harmless to repeat, for a database that has its tables but not
// the record of them. `ALTER TABLE` cannot be, so it relies on a recorded
// migration never being printed again.
function repeatableSql(statement: string): string {
  const sql = statement.trim().replace(/;$/u, "");
  return `${sql.replace(/^CREATE (TABLE|INDEX) (?!IF NOT EXISTS\b)/u, "CREATE $1 IF NOT EXISTS ")};`;
}

const { values } = parseArgs({ options: { applied: { type: "string" } } });
const applied = values.applied === undefined ? new Set<string>() : readAppliedIds(values.applied);

const lines = [
  "CREATE TABLE IF NOT EXISTS storage_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);",
];
for (const migration of STORAGE_MIGRATIONS) {
  if (applied.has(migration.id)) continue;
  for (const statement of migration.statements) lines.push(repeatableSql(statement));
  lines.push(`INSERT OR IGNORE INTO storage_migrations (id) VALUES ('${migration.id}');`);
}
console.log(lines.join("\n"));

import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

import { applyStorageMigrations, STORAGE_MIGRATIONS } from "../src/migrations.ts";

it("applies every migration once from an empty schema", async () => {
  const worker = new Miniflare({
    host: "127.0.0.1",
    compatibilityDate: "2026-07-30",
    modules: true,
    d1Databases: { DB: "migration-test" },
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
  });
  try {
    const database: D1Database = await worker.getD1Database("DB");
    await applyStorageMigrations(database);
    await applyStorageMigrations(database);
    const migrations = await database
      .prepare("SELECT id FROM storage_migrations ORDER BY id")
      .all<{ id: string }>();
    expect(migrations.results).toEqual(STORAGE_MIGRATIONS.map(({ id }) => ({ id })));
  } finally {
    await worker.dispose();
  }
});

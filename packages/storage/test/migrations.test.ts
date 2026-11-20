import { createLocalD1 } from "@ai-moves/testing/test/d1";
import { expect, it } from "vitest";

import { applyStorageMigrations, STORAGE_MIGRATIONS } from "../src/migrations.ts";

it("applies every migration once from an empty schema", async () => {
  const { database, dispose } = await createLocalD1(applyStorageMigrations);
  try {
    await applyStorageMigrations(database);
    const migrations = await database
      .prepare("SELECT id FROM storage_migrations ORDER BY id")
      .all<{ id: string }>();
    expect(migrations.results).toEqual(STORAGE_MIGRATIONS.map(({ id }) => ({ id })));
  } finally {
    await dispose();
  }
});

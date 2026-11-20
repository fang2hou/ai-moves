import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createD1Storage } from "../src/d1.ts";
import { applyStorageMigrations } from "../src/migrations.ts";

let worker: Miniflare;
let database: D1Database;

beforeAll(async () => {
  worker = new Miniflare({
    host: "127.0.0.1",
    compatibilityDate: "2026-07-30",
    modules: true,
    d1Databases: { DB: "failure-test" },
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
  });
  database = await worker.getD1Database("DB");
  await applyStorageMigrations(database);
});

afterAll(() => worker.dispose());

it("classifies foreign-key failures as storage unavailable", async () => {
  const storage = createD1Storage(database);
  await expect(
    storage.items.upsertObserved({
      id: "orphan-item",
      source_id: "missing-source",
      external_key: "missing-source:item",
      kind: "changelog",
      url: null,
      title: "Orphan item",
      published_at: null,
      observed_at: 1,
      state: "candidate",
    }),
  ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", kind: "retryable" });
});

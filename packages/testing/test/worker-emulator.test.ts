import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

it("dispatches a local Worker against D1 and rolls back a failed batch", async () => {
  const worker = new Miniflare({
    host: "127.0.0.1",
    compatibilityDate: "2026-07-30",
    modules: true,
    d1Databases: { DB: "test-db" },
    outboundService: () => {
      throw new Error("Unexpected outbound Worker request");
    },
    script: `
      export default {
        async fetch(_request, env) {
          const result = await env.DB.prepare("SELECT name FROM example ORDER BY id").all();
          return Response.json(result.results);
        }
      };
    `,
  });

  try {
    const db: D1Database = await worker.getD1Database("DB");
    await db.exec("CREATE TABLE example (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO example (id, name) VALUES (?, ?)");
    await insert.bind(1, "existing").run();
    await expect(
      db.batch([insert.bind(2, "uncommitted"), insert.bind(1, "duplicate")]),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    const response = await worker.dispatchFetch("http://worker.test/", { redirect: "error" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ name: "existing" }]);
  } finally {
    await worker.dispose();
  }
});

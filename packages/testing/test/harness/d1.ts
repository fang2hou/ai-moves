import { AppError } from "@ai-moves/kernel/errors/app-error";
import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";

export interface LocalD1 {
  readonly database: D1Database;
  readonly dispose: () => Promise<void>;
}

export async function createLocalD1(
  setup: (database: D1Database) => Promise<void>,
): Promise<LocalD1> {
  const worker = new Miniflare({
    host: "127.0.0.1",
    compatibilityDate: "2026-07-30",
    modules: true,
    d1Databases: { DB: "test-db" },
    outboundService: () => {
      throw new AppError("FORBIDDEN", { message: "Unexpected outbound Worker request" });
    },
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
  });
  try {
    const database: D1Database = await worker.getD1Database("DB");
    await setup(database);
    return { database, dispose: () => worker.dispose() };
  } catch (cause) {
    await worker.dispose();
    throw cause;
  }
}

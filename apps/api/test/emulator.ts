import { fileURLToPath } from "node:url";

import { applyStorageMigrations } from "@ai-moves/storage/migrations";
import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare, type WorkerOptions } from "miniflare";
import { build } from "vite";

const workerName = "desk";

function outboundService(): never {
  throw new Error("Unexpected outbound Worker request");
}

export async function bundleWorker(): Promise<string> {
  const result = await build({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    logLevel: "silent",
    build: { write: false },
  });
  const bundles = Array.isArray(result) ? result : [result];
  if (bundles.length === 1) {
    const bundle = bundles[0];
    if (bundle && "output" in bundle && bundle.output.length === 1) {
      const output = bundle.output[0];
      if (output?.type === "chunk") return output.code;
    }
  }
  throw new Error("Expected one bundled Worker module");
}

export async function startDesk(
  script: string,
  bindings: Record<string, string>,
  smoke?: { readonly assertion: string; readonly directory: string },
): Promise<{ worker: Miniflare; database: D1Database }> {
  const api: WorkerOptions = {
    name: workerName,
    compatibilityDate: "2026-07-30",
    modules: true,
    script,
    bindings,
    d1Databases: { DB: "desk-test" },
    outboundService,
    ...(smoke === undefined
      ? {}
      : {
          assets: {
            directory: smoke.directory,
            binding: "ASSETS",
            routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
          },
        }),
  };
  const workers: WorkerOptions[] =
    smoke === undefined
      ? [api]
      : [
          {
            name: "local-access-fixture",
            compatibilityDate: "2026-07-30",
            modules: true,
            bindings: { ASSERTION: smoke.assertion },
            serviceBindings: { API: workerName },
            outboundService,
            script: `
      export default {
        fetch(request, env) {
          request = new Request(request);
          request.headers.set("Cf-Access-Jwt-Assertion", env.ASSERTION);
          return env.API.fetch(request);
        }
      };
    `,
          },
          api,
        ];
  const worker = new Miniflare({ host: "127.0.0.1", workers });
  try {
    const database: D1Database = await worker.getD1Database("DB", workerName);
    await applyStorageMigrations(database);
    return { worker, database };
  } catch (cause) {
    await worker.dispose();
    throw cause;
  }
}

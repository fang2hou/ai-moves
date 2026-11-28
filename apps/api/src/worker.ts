import { systemClock } from "@ai-news-tracker/kernel/clock";
import { createD1Storage } from "@ai-news-tracker/storage-d1/d1";
import type { D1Database } from "@cloudflare/workers-types";

import { createApi } from "./app.ts";

interface WorkerBindings {
  readonly DB: D1Database;
  readonly ASSETS?: { fetch(request: Request): Promise<Response> };
}

const instances = new WeakMap<WorkerBindings, ReturnType<typeof createApi>>();

// oxlint-disable-next-line import/no-default-export -- Workers resolve the fetch handler from the default module export.
export default {
  async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    let api = instances.get(env);
    if (!api) {
      const { items, alerts, deliveries, config } = createD1Storage(env.DB);
      api = createApi({
        items,
        alerts,
        deliveries,
        config,
        clock: systemClock,
        assets: env.ASSETS,
      });
      instances.set(env, api);
    }
    return api.fetch(request);
  },
};

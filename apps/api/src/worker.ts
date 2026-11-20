import { systemClock } from "@ai-moves/kernel/clock";
import { createIdGen } from "@ai-moves/kernel/id";
import { createD1Storage } from "@ai-moves/storage/d1";
import type { D1Database } from "@cloudflare/workers-types";

import { type AccessSettings, createAccessVerifier } from "./access.ts";
import { createApi } from "./app.ts";

interface WorkerBindings extends AccessSettings {
  readonly DB: D1Database;
  readonly ASSETS?: { fetch(request: Request): Promise<Response> };
}

const instances = new WeakMap<WorkerBindings, ReturnType<typeof createApi>>();
const ids = createIdGen({ clock: systemClock });

// oxlint-disable-next-line import/no-default-export -- Workers resolve the fetch handler from the default module export.
export default {
  async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    let api = instances.get(env);
    if (!api) {
      api = createApi({
        ...createD1Storage(env.DB),
        clock: systemClock,
        ids,
        verifyAccess: createAccessVerifier(env, systemClock),
        assets: env.ASSETS,
      });
      instances.set(env, api);
    }
    return api.fetch(request);
  },
};

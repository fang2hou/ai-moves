import type { AppConfig } from "@ai-moves/contracts/config";
import type { Item } from "@ai-moves/contracts/entities";
import type { Clock, IdGen, JobBus, Telemetry } from "@ai-moves/contracts/ports/runtime";
import type { ItemRepo } from "@ai-moves/contracts/ports/storage";

import { publishJobs } from "./jobs.ts";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export interface RefreshPorts {
  readonly items: Pick<ItemRepo, "listStale" | "transition">;
  readonly jobs: JobBus;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly telemetry: Pick<Telemetry, "count">;
}

// A published story keeps moving: comments arrive and the mood shifts. The page
// is expected to show the current reading, so a story whose discussion has grown
// is sent back through deep analysis, which overwrites its document in place.
export async function refreshPublishedItems(
  ports: RefreshPorts,
  config: AppConfig["ai"],
  limit: number,
): Promise<void> {
  const now = ports.clock.now();
  const candidates = await ports.items.listStale({
    states: ["feed_only", "alerted"],
    updatedBefore: now - config.refresh_interval_minutes * MINUTE_MS,
    limit,
  });
  const due = candidates.filter((item) => dueForRefresh(item, now, config));
  ports.telemetry.count("pipeline.refresh.due", due.length);
  if (due.length === 0) return;

  const traceId = ports.ids.next();
  const claimed: Item[] = [];
  for (const item of due) {
    const moved = await ports.items.transition({
      id: item.id,
      from: item.state,
      to: "triaged_pass",
      expected: item,
      at: now,
    });
    if (moved) claimed.push(item);
  }
  if (claimed.length === 0) return;
  await publishJobs(
    ports.jobs,
    claimed.map((item) => ({
      v: 1 as const,
      type: "deep" as const,
      item_id: item.id,
      trace_id: traceId,
    })),
  );
  ports.telemetry.count("pipeline.refresh.published", claimed.length);
}

function dueForRefresh(item: Item, now: number, config: AppConfig["ai"]): boolean {
  if (item.score_json?.kind !== "hn") return false;
  if (item.score_json.features.age_h > config.refresh_max_age_hours) return false;
  // Re-reading a story nobody is talking about any more would cost a model call
  // and change nothing.
  const sinceAnalysis = (now - item.state_updated_at) / HOUR_MS;
  const growth = item.score_json.features.vc * sinceAnalysis;
  return growth >= config.refresh_min_new_comments;
}

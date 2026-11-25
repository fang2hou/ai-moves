import type { AppConfig } from "@ai-moves/contracts/config";
import type { Item, ItemSnapshot } from "@ai-moves/contracts/entities";
import type { HnClient, HnStory } from "@ai-moves/contracts/ports/sources";
import type { ItemRepo, ItemSnapshotRepo } from "@ai-moves/contracts/ports/storage";
import type { HnFeatures } from "@ai-moves/contracts/scoring";
import {
  computeHnActivity,
  computeHnHeat,
  scaleHnConfig,
  scoreHn,
} from "@ai-moves/core/scoring/hn";

import { observeItem, recordScore, type ObservationState } from "./observations.ts";

const HOUR_MS = 3_600_000;
const HN_KEY_PREFIX = "hn:";

interface RankedStory {
  readonly story: HnStory;
  readonly rank: number | null;
}

export type RankedStories = readonly RankedStory[];

interface StorySeries {
  readonly item: Item;
  readonly sample: HnFeatures;
  readonly hasVelocity: boolean;
  // Earlier gate observations, oldest first.
  readonly history: readonly HnFeatures[];
}

export async function hnTrackingIds(
  items: Pick<ItemRepo, "listBySourceAndStates">,
  sourceId: string,
  limit: number,
): Promise<readonly number[]> {
  const tracked = await items.listBySourceAndStates(sourceId, ["discovered", "tracking"], limit);
  const ids: number[] = [];
  for (const item of tracked) {
    if (!item.external_key.startsWith(HN_KEY_PREFIX)) continue;
    const id = Number(item.external_key.slice(HN_KEY_PREFIX.length));
    if (Number.isSafeInteger(id) && id > 0) ids.push(id);
  }
  return ids;
}

export async function readHn(
  hn: HnClient,
  source: { readonly top_n: number; readonly track_limit: number },
  tracked: readonly number[],
  config: AppConfig["hn"],
): Promise<RankedStories> {
  const top = await hn.listTopStoryIds();
  const ranks = new Map<number, number | null>();
  for (let index = 0; index < Math.min(top.length, source.top_n); index++) {
    const id = top[index];
    if (id !== undefined && !ranks.has(id)) ranks.set(id, index + 1);
  }
  const limit = Math.max(source.top_n, source.track_limit);
  for (const id of tracked) {
    if (ranks.size >= limit) break;
    if (!ranks.has(id)) ranks.set(id, null);
  }

  const results: RankedStory[] = [];
  const ids = [...ranks.keys()];
  for (let offset = 0; offset < ids.length; offset += config.fetch_concurrency) {
    const stories = await Promise.all(
      ids.slice(offset, offset + config.fetch_concurrency).map(async (id) => {
        const story = await hn.getStory(id);
        if (story === null || story.deleted || story.dead || story.type !== "story") return null;
        return { story, rank: ranks.get(id) ?? null };
      }),
    );
    for (const story of stories) if (story !== null) results.push(story);
  }
  return results;
}

export async function observeHn(
  state: ObservationState,
  snapshots: Pick<ItemSnapshotRepo, "insertIfAbsent" | "listSince">,
  sourceId: string,
  stories: RankedStories,
  config: AppConfig["hn"],
  candidates: Set<string>,
): Promise<void> {
  const series: StorySeries[] = [];
  const rankedVps: number[] = [];
  const velocityFloor = Math.max(3, config.gate_burst.consecutive_samples);
  for (const { story, rank } of stories) {
    if (!state.beforeExpiry()) return;
    const item = await observeItem(state, {
      source_id: sourceId,
      external_key: `${HN_KEY_PREFIX}${story.id}`,
      kind: "hn",
      url: story.url ?? `https://news.ycombinator.com/item?id=${story.id}`,
      title: story.title.trim().slice(0, 1000) || `Hacker News story ${story.id}`,
      published_at: story.published_at,
    });
    if (!state.beforeExpiry()) return;
    await snapshots.insertIfAbsent({
      item_id: item.id,
      sampled_at: state.sampledAt,
      rank,
      points: story.points,
      comments: story.comments,
    });
    const canScore = item.state === "discovered" || item.state === "tracking";
    if (!canScore && rank === null) continue;
    // Include a full velocity window for the prior burst heats and their acceleration.
    const windowMs = config.window_minutes * 60_000;
    const windowSince = Math.max(0, state.sampledAt - windowMs * 3);
    let recent = await snapshots.listSince(item.id, windowSince);
    const oldestHeatIndex = recent.length - config.gate_burst.consecutive_samples;
    const baselineIndex = windowStart(recent, oldestHeatIndex, windowMs, velocityFloor);
    const baseline = recent[baselineIndex];
    if (
      recent.length < config.gate_sustained.consecutive_samples ||
      baselineIndex < velocityFloor - 1 ||
      (baseline !== undefined && baseline.sampled_at - windowMs < windowSince)
    ) {
      const since = Math.max(0, state.sampledAt - config.snapshot_retention_hours * HOUR_MS);
      if (since < windowSince) recent = await snapshots.listSince(item.id, since);
    }
    const scored = samplingFeatures(recent, story.published_at, state.sampledAt, config);
    if (scored === undefined) continue;
    if (scored.sample.rank !== null && scored.hasVelocity) rankedVps.push(scored.sample.vp);
    if (canScore) series.push({ item, ...scored });
  }

  const activity = computeHnActivity(rankedVps, config.activity);
  const effectiveConfig = scaleHnConfig(config, activity);
  for (const { item, sample, history } of series) {
    if (!state.beforeExpiry()) return;
    const score = scoreHn({
      features: sample,
      history: {
        heat: history.map((features) => computeHnHeat(features, effectiveConfig)),
        ranks: history.map((features) => features.rank),
      },
      config: effectiveConfig,
      computedAt: state.sampledAt,
    });
    const qualifies = score.gates.length > 0;
    let target: Item["state"] = item.state;
    if (qualifies) {
      target = "triaged_pass";
    } else if (item.state === "discovered") {
      target = "tracking";
    } else if (sample.rank === null && sample.age_h > config.gate_burst.max_age_hours) {
      target = "archived";
    }

    if (await recordScore(state, item, target, { score_json: score, tier: score.level })) {
      if (target === "triaged_pass") candidates.add(item.id);
    }
  }
}

// Preserve the velocity sample floor when polling is sparse.
function windowStart(
  snapshots: readonly ItemSnapshot[],
  index: number,
  windowMs: number,
  floor: number,
  first = 0,
): number {
  const current = snapshots[index];
  if (current === undefined) return first;
  const cutoff = current.sampled_at - windowMs;
  while (first <= index - floor && (snapshots[first]?.sampled_at ?? Infinity) < cutoff) first++;
  return first;
}

function samplingFeatures(
  snapshots: readonly ItemSnapshot[],
  publishedAt: number,
  sampledAt: number,
  config: AppConfig["hn"],
): Omit<StorySeries, "item"> | undefined {
  const series: HnFeatures[] = [];
  const fewest = Math.max(3, config.gate_burst.consecutive_samples);
  let first = 0;
  const windowMs = config.window_minutes * 60_000;
  for (let index = 0; index < snapshots.length; index++) {
    const current = snapshots[index];
    if (current === undefined || current.sampled_at > sampledAt) break;
    first = windowStart(snapshots, index, windowMs, fewest, first);
    const initial = snapshots[first] ?? current;
    const elapsedMs = current.sampled_at - initial.sampled_at;
    const vp = elapsedMs === 0 ? 0 : ((current.points - initial.points) * HOUR_MS) / elapsedMs;
    const vc = elapsedMs === 0 ? 0 : ((current.comments - initial.comments) * HOUR_MS) / elapsedMs;
    // Snapshot times are unique per item. Only the first observation lacks a measured velocity.
    const baselineIndex = Math.max(first, 1);
    const baseline = series[baselineIndex];
    const baselineSnapshot = snapshots[baselineIndex];
    const acc =
      baseline !== undefined && baselineSnapshot !== undefined
        ? (vp - baseline.vp) / ((current.sampled_at - baselineSnapshot.sampled_at) / HOUR_MS)
        : 0;
    series.push({
      vp,
      vc,
      acc,
      climb: initial.rank === null || current.rank === null ? 0 : initial.rank - current.rank,
      points: current.points,
      comments: current.comments,
      rank: current.rank,
      age_h: Math.max(0, (current.sampled_at - publishedAt) / HOUR_MS),
    });
  }
  const sample = series.at(-1);
  if (sample === undefined || snapshots[series.length - 1]?.sampled_at !== sampledAt) {
    return undefined;
  }
  return {
    sample,
    hasVelocity: series.length > 1,
    history: series.slice(
      -Math.max(config.gate_sustained.consecutive_samples, config.gate_burst.consecutive_samples),
      -1,
    ),
  };
}

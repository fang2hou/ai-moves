import type { AppConfig } from "@ai-moves/contracts/config";
import type { Item, ItemSnapshot } from "@ai-moves/contracts/entities";
import type { HnClient, HnStory } from "@ai-moves/contracts/ports/sources";
import type { ItemRepo, ItemSnapshotRepo } from "@ai-moves/contracts/ports/storage";
import type { HnFeatures } from "@ai-moves/contracts/scoring";
import { computeHnHeat, scoreHn } from "@ai-moves/core/scoring/hn";

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
  readonly history: readonly { readonly at: number; readonly features: HnFeatures }[];
}

export async function hnTrackingIds(
  items: Pick<ItemRepo, "listBySourceAndStates">,
  sourceId: string,
  limit: number,
): Promise<readonly number[]> {
  const tracked = await items.listBySourceAndStates(
    sourceId,
    ["discovered", "tracking", "candidate", "triaged_reject"],
    limit,
  );
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
  const lookback = config.window_minutes * 60_000;
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
    const recent = await snapshots.listSince(item.id, Math.max(0, state.sampledAt - lookback));
    const featureSeries = samplingFeatures(recent, story.published_at, state.sampledAt, config);
    const latest = featureSeries.at(-1);
    if (latest?.at === state.sampledAt) {
      featureSeries.pop();
      series.push({ item, sample: latest.features, history: featureSeries });
    }
  }

  for (const { item, sample, history } of series) {
    if (!state.beforeExpiry()) return;
    if (item.state === "candidate" && item.score_json?.computed_at === state.sampledAt) {
      candidates.add(item.id);
    }
    if (item.state !== "discovered" && item.state !== "tracking" && item.state !== "triaged_reject")
      continue;
    const recent = history.filter(
      ({ at }) => state.sampledAt - at <= config.window_minutes * 60_000,
    );
    const score = scoreHn({
      features: sample,
      history: {
        heat: recent.map(({ features }) => computeHnHeat(features, config)),
        ranks: recent.map(({ features }) => features.rank),
      },
      config,
      computedAt: state.sampledAt,
    });
    const qualifies = score.gates.length > 0;
    let target: Item["state"] = item.state;
    if (item.state === "triaged_reject") {
      if (qualifies && item.attempts === 1 && heatRank(score.level) > heatRank(item.tier))
        target = "candidate";
      else continue;
    } else if (qualifies) {
      target = "candidate";
    } else if (item.state === "discovered") {
      target = "tracking";
    } else if (sample.rank === null && sample.age_h > config.gate_burst.max_age_hours) {
      target = "archived";
    }

    if (await recordScore(state, item, target, { score_json: score, tier: score.level })) {
      if (target === "candidate") candidates.add(item.id);
    }
  }
}

function heatRank(level: Item["tier"]): number {
  return level === null ? 0 : Number(level[1]);
}

function samplingFeatures(
  snapshots: readonly ItemSnapshot[],
  publishedAt: number,
  sampledAt: number,
  config: AppConfig["hn"],
): { at: number; features: HnFeatures }[] {
  const series: { at: number; features: HnFeatures }[] = [];
  let first = 0;
  let previous: ItemSnapshot | undefined;
  let previousVelocity = 0;
  for (let index = 0; index < snapshots.length; index++) {
    const current = snapshots[index];
    if (current === undefined || current.sampled_at > sampledAt) break;
    const cutoff = current.sampled_at - config.window_minutes * 60_000;
    while (first < index && (snapshots[first]?.sampled_at ?? Infinity) < cutoff) first++;
    const initial = snapshots[first] ?? current;
    const hours = (current.sampled_at - initial.sampled_at) / HOUR_MS;
    const vp = hours === 0 ? 0 : (current.points - initial.points) / hours;
    const vc = hours === 0 ? 0 : (current.comments - initial.comments) / hours;
    const between =
      previous === undefined ? 0 : (current.sampled_at - previous.sampled_at) / HOUR_MS;
    series.push({
      at: current.sampled_at,
      features: {
        vp,
        vc,
        acc: between === 0 ? 0 : (vp - previousVelocity) / between,
        climb: initial.rank === null || current.rank === null ? 0 : initial.rank - current.rank,
        points: current.points,
        comments: current.comments,
        rank: current.rank,
        age_h: Math.max(0, (current.sampled_at - publishedAt) / HOUR_MS),
      },
    });
    previous = current;
    previousVelocity = vp;
  }
  return series;
}

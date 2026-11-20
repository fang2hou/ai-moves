import { AppConfigSchema } from "@ai-moves/contracts/config";
import type {
  Delivery,
  Item,
  ItemRevision,
  ItemSnapshot,
  Source,
} from "@ai-moves/contracts/entities";
import type { PollJob } from "@ai-moves/contracts/messages";
import type { Telemetry } from "@ai-moves/contracts/ports/runtime";
import type { PollWork } from "@ai-moves/contracts/ports/storage";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { createInMemoryBlobStore } from "@ai-moves/testing/fakes/blob-store";
import { createFakeClock } from "@ai-moves/testing/fakes/clock";
import { createScriptedGitHubClient } from "@ai-moves/testing/fakes/github";
import { createScriptedHnClient } from "@ai-moves/testing/fakes/hn";
import { createInMemoryJobBus } from "@ai-moves/testing/fakes/job-bus";
import { expect, test, vi } from "vitest";

import { pollSource, type PollPorts } from "../src/poll.ts";
import { sweepStaleWork, type SweepPorts } from "../src/sweep.ts";
import { dispatchDueSources } from "../src/tick.ts";

const BUCKET_MS = 300_000;
const AT = 1_795_132_800_000;
const JOB: PollJob = {
  v: 1,
  type: "poll",
  source_id: "source",
  tick_bucket: AT / BUCKET_MS,
  trace_id: "test_trace",
};
const MODEL = { provider: "fixture", model: "fixture", max_output_tokens: 100 };
const CONFIG = AppConfigSchema.parse({
  models: { triage: MODEL, deep: MODEL, translate: MODEL },
  hn: { gate_sustained: { consecutive_samples: 1 } },
  retry: { poll: { degraded_after_failures: 2, max_backoff_seconds: 900 } },
});
const SOURCE: Source = {
  id: "source",
  key: "hn_top",
  kind: "hn_top",
  config_json: { kind: "hn_top", top_n: 10, track_limit: 10 },
  cursor_json: { kind: "hn_top" },
  status: "active",
  consecutive_failures: 0,
  poll_interval_sec: 300,
  next_poll_at: AT,
  last_success_at: null,
  created_at: AT,
  updated_at: AT,
};
const GITHUB_SOURCE: Source = {
  ...SOURCE,
  key: "github:fixture/cli",
  kind: "github_repo",
  config_json: {
    kind: "github_repo",
    owner: "fixture",
    repo: "cli",
    strategy: "release_first",
    changelog_path: "CHANGELOG.md",
  },
  cursor_json: {
    kind: "github_repo",
    releases_etag: null,
    tags_etag: null,
    changelog_sha: null,
    known_versions: [],
  },
};

function generatedIds(): { next(): string } {
  let id = 0;
  return { next: () => `test_${++id}` };
}

function harness(source: Source) {
  const clock = createFakeClock(AT);
  const jobs = createInMemoryJobBus();
  const items = new Map<string, Item>();
  const samples: ItemSnapshot[] = [];
  const revisions: ItemRevision[] = [];
  const ports = {
    clock,
    jobs,
    ids: generatedIds(),
    sources: {
      claimPoll: vi.fn<PollPorts["sources"]["claimPoll"]>().mockResolvedValue(source),
      finishPoll: vi.fn<PollPorts["sources"]["finishPoll"]>().mockResolvedValue(true),
    },
    items: {
      listBySourceAndStates: vi
        .fn<PollPorts["items"]["listBySourceAndStates"]>()
        .mockImplementation(async () => [...items.values()]),
      upsertObserved: vi
        .fn<PollPorts["items"]["upsertObserved"]>()
        .mockImplementation(async (row) => {
          const prior = items.get(row.id);
          if (prior !== undefined) return { value: prior, created: false };
          const item: Item = {
            ...row,
            content_hash: null,
            revision: 0,
            state_updated_at: row.observed_at,
            score_json: null,
            tier: null,
            cluster_id: null,
            attempts: 0,
            next_attempt_at: null,
            first_seen_at: row.observed_at,
            last_seen_at: row.observed_at,
          };
          items.set(item.id, item);
          return { value: item, created: true };
        }),
      transition: vi.fn<PollPorts["items"]["transition"]>().mockImplementation(async (change) => {
        const item = items.get(change.id);
        if (item?.state !== change.from) return false;
        items.set(item.id, {
          ...item,
          ...change.patch,
          state: change.to,
          state_updated_at: change.at,
        });
        return true;
      }),
    },
    snapshots: {
      insertIfAbsent: async (snapshot) => {
        if (
          samples.some(
            (stored) =>
              stored.item_id === snapshot.item_id && stored.sampled_at === snapshot.sampled_at,
          )
        )
          return false;
        samples.push(snapshot);
        return true;
      },
      listSince: async (id, since) =>
        samples.filter((row) => row.item_id === id && row.sampled_at >= since),
    },
    revisions: {
      insertIfAbsent: async (revision) => {
        if (
          revisions.some(
            (row) => row.item_id === revision.item_id && row.content_hash === revision.content_hash,
          )
        )
          return false;
        revisions.push(revision);
        return true;
      },
      listByItem: async (id) => revisions.filter((row) => row.item_id === id),
    },
    blobs: createInMemoryBlobStore(),
    hn: createScriptedHnClient({}),
    github: createScriptedGitHubClient({}),
  } satisfies PollPorts;
  return { ports, items, samples, revisions };
}

test("a partially accepted poll batch resumes from stored buckets on a later tick", async () => {
  const clock = createFakeClock(AT);
  const jobs = createInMemoryJobBus();
  const count = vi.fn<Telemetry["count"]>();
  const ready = [
    { source_id: "first", tick_bucket: JOB.tick_bucket },
    { source_id: "second", tick_bucket: JOB.tick_bucket },
  ];
  const durable: PollWork[] = [];
  const ports = {
    clock,
    jobs,
    ids: generatedIds(),
    telemetry: { count },
    sources: {
      scheduleDue: async (_now: number, bucket: number) => {
        if (durable.length === 0) {
          durable.push(...ready.map((row) => ({ ...row, tick_bucket: bucket })));
        }
      },
      listReadyPolls: async () => durable,
    },
  };

  jobs.failSendAfter(1);
  await expect(
    dispatchDueSources(ports, { scheduled_time: AT + 1, cron: "*/5 * * * *" }, 10),
  ).rejects.toMatchObject({ code: "QUEUE_UNAVAILABLE" });
  expect(jobs.jobs("q-poll")).toEqual([expect.objectContaining(ready[0])]);
  expect(count.mock.calls).toEqual([["pipeline.dispatch.ready", 2]]);
  clock.advance(BUCKET_MS);
  await dispatchDueSources(ports, { scheduled_time: clock.now(), cron: "*/5 * * * *" }, 10);
  expect(jobs.jobs("q-poll")).toEqual([
    expect.objectContaining(ready[0]),
    expect.objectContaining(ready[0]),
    expect.objectContaining(ready[1]),
  ]);
  expect(count.mock.calls.slice(1)).toEqual([
    ["pipeline.dispatch.ready", 2],
    ["pipeline.dispatch.published", 2],
  ]);
});

test("an unowned duplicate makes no upstream request and an expired completion cannot publish", async () => {
  const { ports, samples, items } = harness(SOURCE);
  const story = {
    id: 7,
    type: "story",
    title: "New fixture tool",
    url: null,
    text: null,
    author: "fixture",
    points: 40,
    comments: 3,
    published_at: AT - BUCKET_MS,
    deleted: false,
    dead: false,
  } as const;
  const hn = createScriptedHnClient({
    listTopStoryIds: [
      { kind: "return", value: [story.id] },
      { kind: "return", value: [story.id] },
    ],
    getStory: [
      { kind: "return", value: story },
      { kind: "return", value: story },
    ],
  });
  const pollPorts = { ...ports, hn };
  const options = { config: CONFIG, leaseMs: 10_000 };
  ports.clock.advance(2700);
  ports.sources.claimPoll.mockResolvedValueOnce(null);
  await expect(pollSource(pollPorts, JOB, options)).resolves.toEqual({ status: "not_claimed" });
  expect(hn.calls.listTopStoryIds).toEqual([]);

  ports.sources.finishPoll.mockResolvedValueOnce(false);
  await expect(pollSource(pollPorts, JOB, options)).resolves.toEqual({ status: "claim_lost" });
  expect([...items.values()]).toMatchObject([
    {
      state: "candidate",
      score_json: { gates: ["G3"], computed_at: AT },
    },
  ]);
  expect(ports.jobs.jobs("q-triage")).toEqual([]);

  ports.clock.advance(10_000);
  await expect(pollSource(pollPorts, JOB, options)).resolves.toEqual({ status: "completed" });
  expect(samples).toEqual([expect.objectContaining({ sampled_at: AT, points: story.points })]);
  expect(ports.jobs.jobs("q-triage")).toEqual([
    expect.objectContaining({ item_id: samples[0]?.item_id }),
  ]);
  const owners = ports.sources.claimPoll.mock.calls.map(([, lease]) => lease.owner);
  expect(new Set(owners).size).toBe(3);
});

test("GitHub 304 preserves the validator and an unchanged normalized body adds no revision", async () => {
  const { ports, revisions } = harness(GITHUB_SOURCE);
  const release = {
    tag: "v2.0.0",
    name: "Fixture CLI 2",
    body: "New API.\r\n",
    prerelease: false,
    draft: false,
    published_at: AT,
    url: "https://github.com/fixture/cli/releases/tag/v2.0.0",
  };
  const github = createScriptedGitHubClient({
    listReleases: [
      { kind: "return", value: { status: "modified", etag: '"first"', value: [release] } },
      { kind: "return", value: { status: "not_modified" } },
      {
        kind: "return",
        value: { status: "modified", etag: '"second"', value: [{ ...release, body: "New API." }] },
      },
    ],
  });
  const pollPorts = { ...ports, github };
  const options = { config: CONFIG, leaseMs: 10_000 };
  persistSourceOutcomes(ports, GITHUB_SOURCE);
  for (let index = 0; index < 3; index++) {
    await expect(
      pollSource(pollPorts, { ...JOB, tick_bucket: JOB.tick_bucket + index }, options),
    ).resolves.toEqual({ status: "completed" });
    ports.clock.advance(BUCKET_MS);
  }
  expect(github.calls.listReleases.map(([, request]) => request.etag)).toEqual([
    null,
    '"first"',
    '"first"',
  ]);
  expect(revisions).toEqual([expect.objectContaining({ origin: "release", observed_at: AT })]);
  expect(ports.jobs.jobs("q-triage")).toEqual([
    expect.objectContaining({ item_id: revisions[0]?.item_id }),
  ]);
});

test("rate limits persist bounded backoff and degrade the source without changing its cursor", async () => {
  const { ports } = harness({
    ...GITHUB_SOURCE,
    consecutive_failures: 1,
    last_success_at: AT - BUCKET_MS,
  });
  const github = createScriptedGitHubClient({
    listReleases: [
      { kind: "reject", error: new AppError("UPSTREAM_RATE_LIMITED", { retryAfterMs: 1_200_000 }) },
    ],
  });
  ports.clock.advance(79);
  await expect(
    pollSource({ ...ports, github }, JOB, { config: CONFIG, leaseMs: 10_000 }),
  ).resolves.toMatchObject({ status: "backoff", error: { code: "UPSTREAM_RATE_LIMITED" } });
  expect(ports.sources.finishPoll.mock.calls[0]?.[2]).toEqual({
    at: AT + 79,
    next_poll_at: AT + 79 + 900_000,
    consecutive_failures: 2,
    status: "degraded",
  });
});

function persistSourceOutcomes(ports: ReturnType<typeof harness>["ports"], initial: Source): void {
  let source = initial;
  ports.sources.claimPoll.mockImplementation(async () => source);
  ports.sources.finishPoll.mockImplementation(async (_work, _owner, outcome) => {
    source = {
      ...source,
      ...outcome,
      cursor_json: outcome.cursor_json ?? source.cursor_json,
      last_success_at: outcome.last_success_at ?? source.last_success_at,
    };
    return true;
  });
}

test("sweep releases final analysis leases once without changing attempts or bypassing backoff", async () => {
  const clock = createFakeClock(AT);
  const jobs = createInMemoryJobBus();
  const count = vi.fn<Telemetry["count"]>();
  const old = AT - 1_000_000;
  const baseItem: Item = {
    id: "ready",
    source_id: "source",
    external_key: "hn:1",
    kind: "hn",
    title: "fixture",
    url: null,
    published_at: null,
    content_hash: null,
    revision: 0,
    state: "candidate",
    state_updated_at: old,
    score_json: null,
    tier: null,
    cluster_id: null,
    attempts: 0,
    next_attempt_at: AT,
    first_seen_at: old,
    last_seen_at: old,
  };
  const lastTriage = {
    ...baseItem,
    id: "last_triage",
    state: "triaging",
    attempts: 4,
  } satisfies Item;
  const lastDeep = { ...lastTriage, id: "last_deep", state: "analyzing" } satisfies Item;
  const raced = { ...lastTriage, id: "raced" };
  const fixtures = [
    baseItem,
    lastTriage,
    lastDeep,
    raced,
    {
      ...lastTriage,
      id: "retry_later",
      next_attempt_at: AT + 1,
    },
  ];
  const rows = new Map<string, Item>(fixtures.map((item) => [item.id, item]));
  const pending: Delivery = {
    id: "pending",
    alert_id: "alert",
    destination_id: "dest",
    idempotency_key: "a".repeat(64),
    state: "pending",
    state_updated_at: old,
    attempts: 0,
    provider_message_id: null,
    last_error: null,
    next_attempt_at: AT,
    expires_at: AT + 10_000,
    lang: "en",
    dry_run: true,
    suppressed_reason: null,
    created_at: old,
  };
  const sending = { ...pending, id: "sending", state: "sending", attempts: 1 } satisfies Delivery;
  const racedSend = { ...sending, id: "raced_send" };
  let expiredSends: readonly Delivery[] = [sending, racedSend];
  const recover = vi.fn<SweepPorts["items"]["transition"]>(async (change) => {
    const row = rows.get(change.id);
    if (
      row?.state !== change.from ||
      row.attempts !== change.expected?.attempts ||
      row.state_updated_at !== change.expected.state_updated_at
    )
      return false;
    rows.set(row.id, { ...row, ...change.patch, state: change.to, state_updated_at: change.at });
    return true;
  });
  const recoverDelivery = vi.fn<SweepPorts["deliveries"]["transition"]>(async ({ id }) => {
    expiredSends = expiredSends.filter((row) => row.id !== id);
    return id === sending.id;
  });
  const ports: SweepPorts = {
    clock,
    jobs,
    ids: generatedIds(),
    telemetry: { count },
    items: {
      listStale: async (query) => {
        const stale = [...rows.values()].filter(
          (row) =>
            query.states.includes(row.state) &&
            row.state_updated_at < query.updatedBefore &&
            (row.next_attempt_at ?? 0) <= (query.readyAt ?? Infinity),
        );
        if (stale.includes(raced))
          rows.set(raced.id, { ...raced, attempts: raced.attempts + 1, next_attempt_at: AT + 1 });
        return stale;
      },
      transition: recover,
    },
    deliveries: {
      listDue: async () => [pending],
      listStale: async ({ states }) => (states.includes("sending") ? expiredSends : []),
      transition: recoverDelivery,
    },
    snapshots: { deleteBefore: async () => 0 },
  };
  await sweepStaleWork(ports, { config: CONFIG, limit: 10 });
  expect(jobs.drain("q-triage").map((job) => job.type === "triage" && job.item_id)).toEqual([
    "ready",
    "last_triage",
  ]);
  expect(jobs.drain("q-deep")).toMatchObject([{ item_id: "last_deep" }]);
  expect(jobs.jobs("q-deliver")).toEqual([expect.objectContaining({ delivery_id: "pending" })]);
  expect(
    [...rows.values()].map(({ id, state, attempts, next_attempt_at }) => [
      id,
      state,
      attempts,
      next_attempt_at,
    ]),
  ).toEqual([
    ["ready", "candidate", 0, AT],
    ["last_triage", "candidate", 4, AT],
    ["last_deep", "triaged_pass", 4, AT],
    ["raced", "triaging", 5, AT + 1],
    ["retry_later", "triaging", 4, AT + 1],
  ]);
  expect(recoverDelivery.mock.calls[0]?.[0]).toMatchObject({
    id: "sending",
    to: "unknown",
    expected: sending,
    patch: { last_error: { code: "OUTCOME_UNKNOWN" } },
  });
  expect(count.mock.calls).toEqual([
    ["pipeline.sweep.selected", 2, { group: "sending" }],
    ["pipeline.sweep.recovery", 1, { from: "sending", outcome: "unknown" }],
    ["pipeline.sweep.recovery", 1, { from: "sending", outcome: "fenced" }],
    ["pipeline.sweep.selected", 1, { group: "ready_items" }],
    ["pipeline.sweep.selected", 2, { group: "triaging" }],
    ["pipeline.sweep.recovery", 1, { from: "triaging", outcome: "candidate" }],
    ["pipeline.sweep.recovery", 1, { from: "triaging", outcome: "fenced" }],
    ["pipeline.sweep.selected", 1, { group: "analyzing" }],
    ["pipeline.sweep.recovery", 1, { from: "analyzing", outcome: "triaged_pass" }],
    ["pipeline.sweep.selected", 1, { group: "due_deliveries" }],
    ["pipeline.sweep.snapshots_deleted", 0],
    ["pipeline.sweep.published", 4],
  ]);

  count.mockClear();
  jobs.failSendAfter(0);
  await expect(sweepStaleWork(ports, { config: CONFIG, limit: 10 })).rejects.toMatchObject({
    code: "QUEUE_UNAVAILABLE",
  });
  expect(count).toHaveBeenCalledWith("pipeline.sweep.selected", 1, { group: "ready_items" });
  expect(count).not.toHaveBeenCalledWith("pipeline.sweep.published", expect.anything());
  await sweepStaleWork(ports, { config: CONFIG, limit: 10 });
  expect(jobs.jobs("q-triage")).toMatchObject([{ item_id: "ready" }]);
  expect(jobs.jobs("q-deep")).toEqual([]);
});

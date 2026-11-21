import api from "@ai-moves/api/worker";
import { type Job, queueForJob } from "@ai-moves/contracts/messages";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { expect, it } from "vitest";

import { readBindings } from "../src/bindings.ts";
import {
  config,
  DESK,
  ENGLISH,
  EVIDENCE,
  JAPANESE,
  message,
  publish,
  RELEASE,
  seedDestinations,
  seedSource,
  SOURCE,
  START,
  startPipeline,
  syntheticAccess,
  TICK_MS,
  TITLE,
} from "./scenario.ts";

function isJobType<Type extends Job["type"]>(
  job: Job | undefined,
  type: Type,
): job is Extract<Job, { type: Type }> {
  return job?.type === type;
}

function onlyJob<Type extends Job["type"]>(
  jobs: readonly Job[],
  type: Type,
): Extract<Job, { type: Type }> {
  const [job] = jobs;
  if (jobs.length !== 1 || !isJobType(job, type)) {
    throw new AppError("STATE_CONFLICT", { message: `Expected one ${type} job` });
  }
  return job;
}

it("recovers lost ingestion work and serves feed-only alerts with verified language documents", async () => {
  const local = await startPipeline();
  const { worker, env, clock, outgoing, http, logs, storage, tick } = local;
  let destinationLookups = 0;
  const rolloutEnv = {
    ...env,
    get DESTINATION_WEBHOOKS() {
      destinationLookups++;
      return JSON.stringify({
        TEST_EN: "https://hooks.slack.com/fixture/english",
        TEST_JA: "https://discord.com/fixture/japanese",
      });
    },
  };
  const consume = async (job: Job) => {
    const incoming = message(job);
    await worker.queue({ queue: queueForJob(job), messages: [incoming] }, rolloutEnv);
    return incoming.dispositions;
  };
  try {
    await publish(storage, 0, { ...config, ai: { ...config.ai, enabled: false } });
    await seedSource(storage);
    await seedDestinations(storage);

    await tick();
    const poll = onlyJob(outgoing.take("q-poll"), "poll");
    expect(poll).toMatchObject({ source_id: SOURCE, tick_bucket: START / TICK_MS });
    expect(await storage.sources.listReadyPolls(clock.now(), 10)).toEqual([
      { source_id: SOURCE, tick_bucket: poll.tick_bucket },
    ]);
    await publish(storage, 1);
    expect(await storage.audit.listRecent(10)).toMatchObject([
      {
        action: "config.publish",
        target: "config:2",
        actor: "local-operator",
        detail_json: { previous: 1 },
      },
      {
        action: "config.publish",
        target: "config:1",
        actor: "local-operator",
        detail_json: { previous: 0 },
      },
    ]);

    outgoing.failNext("q-triage");
    expect(await consume(poll)).toEqual(["retry"]);
    expect(outgoing.take("q-triage")).toEqual([]);
    expect(await consume(poll)).toEqual(["ack"]);
    expect(http.calls).toEqual(["github"]);
    expect(await storage.sources.get(SOURCE)).toMatchObject({
      last_success_at: START,
      next_poll_at: START + TICK_MS,
      cursor_json: { releases_etag: '"fixture-release"', known_versions: ["v1.2.3"] },
    });

    clock.advance(TICK_MS + 1);
    outgoing.failNext("q-poll");
    await expect(tick()).rejects.toMatchObject({ code: "QUEUE_UNAVAILABLE" });
    const triage = onlyJob(outgoing.take("q-triage"), "triage");
    const itemId = triage.item_id;
    expect(await storage.items.get(itemId)).toMatchObject({
      source_id: SOURCE,
      external_key: "github:example/acme:version:v1.2.3",
      state: "candidate",
      kind: "changelog",
      title: TITLE,
      url: RELEASE,
      revision: 1,
    });
    const [revision] = await storage.revisions.listByItem(itemId);
    if (revision === undefined) throw new AppError("ROW_INVALID");
    const blob = await env.BLOBS.get(revision.r2_key);
    if (blob === null) throw new AppError("ROW_INVALID");
    expect(new TextDecoder().decode(await blob.arrayBuffer())).toBe(EVIDENCE);

    const wrongQueue = message(poll);
    const badVersion = message({ ...triage, v: 99 });
    const firstTriage = message(triage);
    const secondTriage = message(triage);
    await Promise.all([
      worker.queue({ queue: "q-triage", messages: [wrongQueue, badVersion, firstTriage] }, env),
      worker.queue({ queue: "q-triage", messages: [secondTriage] }, env),
    ]);
    expect(wrongQueue.dispositions).toEqual(["retry"]);
    expect(badVersion.dispositions).toEqual(["retry"]);
    expect(firstTriage.dispositions).toEqual(["ack"]);
    expect(secondTriage.dispositions).toEqual(["ack"]);
    expect(await storage.items.get(itemId)).toMatchObject({ state: "triaged_pass" });
    expect(await storage.budgets.get("2026-07-15", "ai:triage:repo:example/acme")).toMatchObject({
      used: 1,
    });

    const deep = onlyJob(outgoing.take("q-deep"), "deep");
    const firstDeep = consume(deep);
    try {
      await Promise.race([http.deepStarted, firstDeep]);
      expect(await storage.items.get(itemId)).toMatchObject({ state: "analyzing" });
      expect(await consume(deep)).toEqual(["ack"]);
    } finally {
      http.finishDeep();
      expect(await firstDeep).toEqual(["ack"]);
    }
    expect(outgoing.take("q-deliver")).toEqual([]);
    expect(await storage.items.get(itemId)).toMatchObject({ state: "feed_only" });
    const rows = await env.DB.prepare(
      "SELECT stage, lang, config_version, status FROM analyses WHERE item_id = ? ORDER BY stage, lang",
    )
      .bind(itemId)
      .all();
    expect(rows.results).toEqual([
      { stage: "deep", lang: "en", config_version: 2, status: "succeeded" },
      { stage: "translate", lang: "ja", config_version: 2, status: "succeeded" },
      { stage: "translate", lang: "zh-CN", config_version: 2, status: "failed" },
      { stage: "triage", lang: "en", config_version: 2, status: "succeeded" },
    ]);

    clock.advance(TICK_MS + 1);
    await worker.scheduled({ scheduledTime: clock.now(), cron: "*/5 * * * *" }, rolloutEnv);
    expect(onlyJob(outgoing.take("q-poll"), "poll")).toMatchObject({
      source_id: SOURCE,
      tick_bucket: poll.tick_bucket + 1,
    });
    expect(logs.map(({ event }) => event)).toContain("pipeline.dispatch_failed");
    expect(logs.filter(({ err }) => err?.code === "MESSAGE_INVALID")).toHaveLength(2);
    for (const replay of [poll, triage, deep]) {
      expect(await consume(replay)).toEqual(["ack"]);
    }
    expect(outgoing.take("q-deep")).toEqual([]);
    expect(outgoing.take("q-deliver")).toEqual([]);
    expect(http.calls).toEqual(["github", "triage", "deep", "translate:zh-CN", "translate:ja"]);
    expect(destinationLookups).toBe(0);
    for (const scope of ["source:changelog", "destination:english", "destination:japanese"]) {
      expect(await storage.budgets.get("2026-07-15", `notify:${scope}`)).toBeNull();
    }

    const access = await syntheticAccess(env.DB);
    const request = (path: string) =>
      api.fetch(new Request(`${DESK}${path}`, { headers: access.headers }), access.bindings);
    expect((await api.fetch(new Request(`${DESK}/api/feed`), access.bindings)).status).toBe(401);
    const feed = await request("/api/feed");
    expect(feed.status).toBe(200);
    expect(await feed.json()).toMatchObject({
      items: [{ id: itemId, title: TITLE, state: "feed_only" }],
    });
    const storedAlerts = await storage.alerts.listFeed({ itemId, limit: 10 });
    const [alert] = storedAlerts;
    if (storedAlerts.length !== 1 || alert === undefined) throw new AppError("ROW_INVALID");
    expect(alert.decision_reason_json.blocked_by).toEqual(["rollout_feed_only"]);
    expect(await storage.deliveries.listByAlert(alert.id)).toEqual([]);
    const item = await request(`/api/items/${itemId}`);
    expect(item.status).toBe(200);
    expect(await item.json()).toMatchObject({ alerts: [{ id: alert.id, decision: "feed_only" }] });
    const alertPath = `/api/alerts/${alert.id}`;
    const japanese = await request(`${alertPath}?lang=ja`);
    expect(japanese.status).toBe(200);
    expect(await japanese.json()).toMatchObject({
      alert: { id: alert.id, item_id: itemId, decision: "feed_only" },
      document: {
        lang: "ja",
        summary: JAPANESE,
        links: { source: RELEASE, detail: `${DESK}/items/${itemId}` },
        key_points: [
          {
            text: "`acme build --jobs 4` を使用してください。",
            evidence_quote: null,
            comment_id: null,
          },
          { text: "出典の根拠", evidence_quote: EVIDENCE, comment_id: null },
        ],
        translation: { machine_translated: true, fell_back_to_english: false },
      },
      deliveries: [],
    });
    const missing = await request(`${alertPath}?lang=zh-CN`);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({
      document: null,
      deliveries: [],
    });
    const english = await request(`${alertPath}?lang=en`);
    expect(english.status).toBe(200);
    expect(await english.json()).toMatchObject({ document: { lang: "en", summary: ENGLISH } });
  } finally {
    await local.dispose();
  }
});

it("rejects bad envelopes, settings, bindings and stored config before durable work or ack", async () => {
  const local = await startPipeline();
  const { worker, env, storage, outgoing, http, tick } = local;
  const scheduled = { scheduledTime: START, cron: "*/5 * * * *" };
  const incoming = message({
    v: 1,
    type: "poll",
    source_id: SOURCE,
    trace_id: "trace",
    tick_bucket: START / TICK_MS,
  });
  const batch = { queue: "q-poll", messages: [incoming] };
  try {
    await seedSource(storage);
    await expect(tick()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(worker.queue(batch, env)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await publish(storage, 0);
    const scopedEnv = { ...env, OTHER_SETTING: "synthetic-worker-setting" };
    const { providerSecrets } = readBindings(scopedEnv);
    for (const ref of ["TEST_EN", "OTHER_SETTING"]) {
      await expect(providerSecrets.get(ref)).rejects.toMatchObject({
        code: "SECRET_MISSING",
        message: "SECRET_MISSING",
      });
    }
    for (const binding of ["DB", "BLOBS", "DEEP_QUEUE", "PROVIDER_HTTP", "PINNED_WEB"]) {
      const incomplete = { ...env };
      Reflect.deleteProperty(incomplete, binding);
      await expect(worker.scheduled(scheduled, incomplete)).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
    }
    const malformed = { ...env, DELIVER_QUEUE: { ...env.DELIVER_QUEUE } };
    Reflect.set(malformed.DELIVER_QUEUE, "sendBatch", "not a function");
    await expect(worker.queue(batch, malformed)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      worker.scheduled(scheduled, { ...env, DESK_ORIGIN: "http://example.test" }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(worker.scheduled(scheduled, { ...env, ENVIRONMENT: "bad" })).rejects.toMatchObject(
      { code: "CONFIG_INVALID" },
    );
    const credentialFailure = message(incoming.body);
    await worker.queue(
      { queue: "q-poll", messages: [credentialFailure] },
      { ...env, GITHUB_TOKEN: " " },
    );
    expect(credentialFailure.dispositions).toEqual(["retry"]);
    await expect(worker.scheduled({ ...scheduled, scheduledTime: -1 }, env)).rejects.toMatchObject({
      code: "MESSAGE_INVALID",
    });
    await expect(worker.queue({ ...batch, queue: "dlq-poll" }, env)).rejects.toMatchObject({
      code: "MESSAGE_INVALID",
    });
    await expect(
      worker.queue({ ...batch, messages: Array.from({ length: 11 }, () => incoming) }, env),
    ).rejects.toMatchObject({ code: "MESSAGE_INVALID" });
    await publish(storage, 1, {
      ...config,
      web_fetch: { ...config.web_fetch, denied_domains: ["not-a-host"] },
    });
    await expect(tick()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await env.DB.prepare("UPDATE config_versions SET config_json = ? WHERE version = 2")
      .bind("{}")
      .run();
    await expect(tick()).rejects.toMatchObject({ code: "ROW_INVALID" });
    await expect(worker.queue(batch, env)).rejects.toMatchObject({ code: "ROW_INVALID" });
    expect(incoming.dispositions).toEqual([]);
    expect(outgoing.take("q-poll")).toEqual([]);
    expect(await storage.sources.listReadyPolls(START, 10)).toEqual([]);
    expect(http.calls).toEqual([]);
  } finally {
    await local.dispose();
  }
});

it.each(["repository", "global"] as const)(
  "denies triage at the %s budget boundary without a model request",
  async (boundary) => {
    const local = await startPipeline();
    const { worker, env, storage, outgoing, http, tick } = local;
    try {
      await publish(storage, 0, {
        ...config,
        ai: { ...config.ai, triage_items_per_day: boundary === "global" ? 0 : 1 },
        changelog: { ...config.changelog, max_triage_per_repo_per_day: 1 },
      });
      await seedSource(storage);
      if (boundary === "repository") {
        await storage.budgets.tryConsume({
          workId: "earlier-work",
          day: "2026-07-15",
          scope: "ai:triage:repo:example/acme",
          amount: 1,
          limit: 1,
        });
      }
      await tick();
      const poll = onlyJob(outgoing.take("q-poll"), "poll");
      await worker.queue({ queue: "q-poll", messages: [message(poll)] }, env);
      const triage = onlyJob(outgoing.take("q-triage"), "triage");
      const incoming = message(triage);
      await worker.queue({ queue: "q-triage", messages: [incoming] }, env);
      await worker.queue({ queue: "q-triage", messages: [message(triage)] }, env);

      expect(incoming.dispositions).toEqual(["ack"]);
      expect(await storage.items.get(triage.item_id)).toMatchObject({ state: "skipped_budget" });
      const analyses = await env.DB.prepare(
        "SELECT status, error_code FROM analyses WHERE item_id = ? AND stage = ?",
      )
        .bind(triage.item_id, "triage")
        .all();
      expect(analyses.results).toEqual([{ status: "failed", error_code: "BUDGET_EXHAUSTED" }]);
      expect(http.calls).toEqual(["github"]);
      expect(outgoing.take("q-deep")).toEqual([]);
      expect(await storage.budgets.get("2026-07-15", "ai:triage:repo:example/acme")).toMatchObject({
        used: 1,
      });
      const global = await storage.budgets.get("2026-07-15", "ai:triage");
      expect(global?.used ?? 0).toBe(0);
    } finally {
      await local.dispose();
    }
  },
);

it("processes valid siblings at the local queue batch limit despite malformed messages", async () => {
  const local = await startPipeline();
  const { worker, env, storage, http } = local;
  try {
    await publish(storage, 0);
    const valid = Array.from({ length: 9 }, (_, index) =>
      message({ v: 1, type: "triage", item_id: `missing-${index}`, trace_id: "trace" }),
    );
    const invalid = message({ v: 2, type: "triage", item_id: "missing", trace_id: "trace" });
    await worker.queue({ queue: "q-triage", messages: [invalid, ...valid] }, env);
    expect(invalid.dispositions).toEqual(["retry"]);
    expect(valid.map(({ dispositions }) => dispositions)).toEqual(
      Array.from({ length: 9 }, () => ["ack"]),
    );
    expect(http.calls).toEqual([]);
  } finally {
    await local.dispose();
  }
});

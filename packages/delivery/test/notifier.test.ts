import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import { AppConfigSchema } from "@ai-moves/contracts/config";
import type { Alert, Delivery, Destination, Item } from "@ai-moves/contracts/entities";
import { describe, expect, it, vi } from "vitest";

import { executeDelivery, type DeliveryPorts } from "../src/execute.ts";
import { planDeliveries } from "../src/finalize.ts";
import { createWebhookNotifier } from "../src/notifiers/webhook.ts";
import { renderDiscord } from "../src/render/discord.ts";
import { renderSlack } from "../src/render/slack.ts";

const doc: AlertDoc = {
  v: 1,
  alert_id: "alert",
  kind: "new",
  item_kind: "hn",
  tier: 2,
  lang: "en",
  source_label: "Example",
  title: { original: "Example <@everyone>", translated: null },
  why_now: "New release",
  summary: "Summary",
  key_points: [],
  engineering_implications: [],
  caveats: [],
  links: {
    source: "https://example.test/source",
    discussion: null,
    detail: "https://example.test/detail",
  },
  translation: { machine_translated: false, fell_back_to_english: false },
  generated_at: 100,
};

const destination: Destination = {
  id: "destination",
  name: "test",
  purpose: "alerts",
  channel: "discord",
  secret_ref: "WEBHOOK",
  lang: "en",
  enabled: true,
  dry_run: false,
  min_tier: 1,
  daily_budget: 8,
  source_filters: { hn: true, changelog: true },
  quiet_hours: null,
  created_at: 100,
  updated_at: 100,
};

describe("webhook delivery", () => {
  it("renders without enabling mentions and respects Discord's limit", () => {
    expect(renderSlack(doc).text).toContain("&lt;@everyone&gt;");
    const rendered = renderDiscord({ ...doc, summary: "a".repeat(2000) });
    expect(rendered.content.length).toBeLessThanOrEqual(2000);
    expect(rendered.content).toContain(doc.links.detail);
    expect(rendered.allowed_mentions.parse).toEqual([]);
  });

  it("requests confirmation and maps the Discord receipt", async () => {
    const requests: Request[] = [];
    const notifier = createWebhookNotifier(
      "discord",
      async (request) => {
        requests.push(request);
        return Response.json({ id: "123" });
      },
      { get: async () => "https://discord.com/api/webhooks/123/synthetic" },
    );
    await expect(notifier.send(destination, doc, "a".repeat(64))).resolves.toEqual({
      provider_message_id: "123",
    });
    const request = requests[0];
    if (request === undefined) throw new Error("Missing request");
    expect(new URL(request.url).searchParams.get("wait")).toBe("true");
    expect(await request.json()).toMatchObject({ allowed_mentions: { parse: [] } });
  });

  it("marks a transport failure unknown without retrying", async () => {
    let attempts = 0;
    const notifier = createWebhookNotifier(
      "discord",
      async () => {
        attempts += 1;
        throw new Error("lost response");
      },
      { get: async () => "https://discord.com/api/webhooks/123/synthetic" },
    );
    await expect(notifier.send(destination, doc, "a".repeat(64))).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(attempts).toBe(1);
  });

  it.each([
    ["slack", 500, "unknown", "OUTCOME_UNKNOWN", false],
    ["discord", 503, "unknown", "OUTCOME_UNKNOWN", false],
    ["discord", 429, "failed_retryable", "UPSTREAM_RATE_LIMITED", true],
    ["slack", 400, "failed_permanent", "UPSTREAM_REJECTED", false],
  ] as const)("%s HTTP %i: delivery and replay", async (...scenario) => {
    const [channel, status, state, code, retries] = scenario;
    const model = { provider: "fixture", model: "fixture", max_output_tokens: 50 };
    const config = AppConfigSchema.parse({
      models: { triage: model, deep: model, translate: model },
      delivery: { force_dry_run: false },
      retry: { deliver: { max_attempts: 2, backoff_seconds: [1] } },
    });
    let now = Date.UTC(2026, 0, 1, 3);
    const alert: Alert = {
      id: doc.alert_id,
      alert_key: "a".repeat(64),
      item_id: "item",
      analysis_id: "analysis",
      cluster_id: "cluster",
      tier: doc.tier,
      kind: doc.kind,
      decision: "send",
      decision_reason_json: {
        why_now: doc.why_now,
        blocked_by: [],
        importance: null,
        impact: null,
        heat_level: null,
        prior: null,
      },
      created_at: now,
    };
    const item: Item = {
      id: alert.item_id,
      source_id: "source",
      external_key: "item-key",
      kind: doc.item_kind,
      url: doc.links.source,
      title: doc.title.original,
      published_at: null,
      content_hash: null,
      revision: 0,
      state: "candidate",
      state_updated_at: now,
      score_json: null,
      tier: null,
      cluster_id: null,
      attempts: 0,
      next_attempt_at: null,
      first_seen_at: now,
      last_seen_at: now,
    };
    const target = { ...destination, channel };
    const [pending] = planDeliveries({
      alert,
      documents: [doc],
      destinations: [target],
      itemKind: item.kind,
      now,
      expiresAt: now + 60_000,
      forceDryRun: false,
      ids: { next: () => "delivery" },
    });
    if (pending === undefined) throw new Error("Missing delivery");
    let row: Delivery = pending;
    const discard = vi.fn<() => Promise<never>>(() => Promise.reject(new Error("cleanup failed")));
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel: discard }), { status }))
      .mockImplementation(async () => Response.json({ id: "123" }));
    const claimForSend = vi.fn<DeliveryPorts["deliveries"]["claimForSend"]>(
      async ({ from, at }) => {
        if (row.state !== from) return { kind: "unavailable" };
        row = { ...row, state: "sending", state_updated_at: at, attempts: row.attempts + 1 };
        return { kind: "claimed", delivery: row };
      },
    );
    const ports: DeliveryPorts = {
      alerts: { get: async () => alert, getDocument: async () => doc },
      deliveries: {
        get: async () => row,
        claimForSend,
        transition: async ({ from, to, at, patch }) => {
          if (row.state !== from) return false;
          row = { ...row, ...patch, state: to, state_updated_at: at };
          return true;
        },
      },
      destinations: { get: async () => target },
      items: { get: async () => item },
      budgets: {
        get: async () => null,
        tryConsume: async ({ day, scope, limit }) => ({
          granted: true,
          entry: { day, scope, used: 1, limit },
        }),
      },
      clock: { now: () => now },
      notifiers: {
        slack: createWebhookNotifier("slack", fetch, {
          get: async () => "https://hooks.slack.com/services/synthetic",
        }),
        discord: createWebhookNotifier("discord", fetch, {
          get: async () => "https://discord.com/api/webhooks/123/synthetic",
        }),
      },
    };
    await executeDelivery(ports, row.id, config);
    expect(row).toMatchObject({ state, attempts: 1, last_error: { code } });
    expect(discard).toHaveBeenCalledOnce();
    expect(row.next_attempt_at !== null).toBe(retries);

    now += 10_000;
    await executeDelivery(ports, row.id, config);
    expect(fetch).toHaveBeenCalledTimes(retries ? 2 : 1);
    expect(claimForSend).toHaveBeenCalledTimes(retries ? 2 : 1);
    expect(row.state).toBe(retries ? "sent" : state);
  });

  it.each([0, 1])("checks the Discord receipt byte cap with %i extra bytes", async (extra) => {
    const bytes = new Uint8Array(64 * 1024 + extra).fill(32);
    bytes.set(new TextEncoder().encode('{"id":"é"}'));
    const cancel = vi.fn<() => void>();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 8));
          controller.enqueue(bytes.subarray(8, -1));
          controller.enqueue(bytes.subarray(-1));
          if (extra === 0) controller.close();
        },
        cancel,
      }),
      { headers: { "content-length": "12" } },
    );
    const notifier = createWebhookNotifier("discord", async () => response, {
      get: async () => "https://discord.com/api/webhooks/123/synthetic",
    });
    const result = await notifier
      .send(destination, doc, "a".repeat(64))
      .catch((error: unknown) => error);
    expect(result).toMatchObject(
      extra === 0 ? { provider_message_id: "é" } : { code: "OUTCOME_UNKNOWN" },
    );
    expect(cancel).toHaveBeenCalledTimes(extra);
  });

  it("discards Slack success without waiting for stream cleanup", async () => {
    const cancel = vi.fn<() => Promise<void>>(() => new Promise<void>(() => undefined));
    const response = new Response(new ReadableStream({ cancel }));
    const notifier = createWebhookNotifier("slack", async () => response, {
      get: async () => "https://hooks.slack.com/services/synthetic",
    });
    const sent = notifier.send({ ...destination, channel: "slack" }, doc, "a".repeat(64));
    await expect(sent).resolves.toEqual({ provider_message_id: null });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

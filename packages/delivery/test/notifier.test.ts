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
  source_label: "Hacker News",
  title: { original: "A smaller build cache", translated: null },
  why_now: "HN readers are comparing cache reuse across runners.",
  summary: "This summary does not need to be repeated on the card.",
  key_points: [
    {
      text: "Source evidence",
      evidence_quote: "We shared the cache across Linux jobs.",
      comment_id: "43",
    },
  ],
  engineering_implications: [],
  caveats: [],
  links: {
    source: "https://example.test/source",
    discussion: "https://news.ycombinator.com/item?id=42",
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

const changelog: AlertDoc = {
  ...doc,
  item_kind: "changelog",
  source_label: "example/cli",
  title: { original: "CLI 2.0", translated: null },
  why_now: "The new defaults affect CI upgrades.",
  engineering_implications: [
    "The new defaults affect CI upgrades.",
    "Update the CI cache configuration before upgrading.",
  ],
  key_points: [
    {
      text: "Source evidence",
      evidence_quote: "Version 2.0 uses a new cache directory by default.",
      comment_id: null,
    },
  ],
  links: {
    ...doc.links,
    source: "https://github.com/example/cli/releases/tag/v2.0.0",
    discussion: null,
  },
};

function scoredItem(document: AlertDoc, now: number): Item {
  return {
    id: "item",
    source_id: "source",
    external_key: document.item_kind === "hn" ? "hn:42" : "example/cli:version:v2.0.0",
    kind: document.item_kind,
    url: document.links.source,
    title: document.title.original,
    published_at: now,
    content_hash: null,
    revision: 0,
    state: "candidate",
    state_updated_at: now,
    score_json:
      document.item_kind === "hn"
        ? {
            kind: "hn",
            heat: 89,
            level: "H2",
            features: {
              vp: 80,
              vc: 40,
              acc: 20,
              climb: 4,
              points: 75,
              comments: 36,
              rank: 5,
              age_h: 2,
            },
            percentiles: null,
            gates: ["G1"],
            cold_start: false,
            computed_at: now,
          }
        : {
            kind: "changelog",
            prior: 55,
            signals: [{ signal: "breaking", points: 25, evidence: ["New cache directory."] }],
            computed_at: now,
          },
    tier: document.item_kind === "hn" ? "H2" : null,
    cluster_id: null,
    attempts: 0,
    next_attempt_at: null,
    first_seen_at: now,
    last_seen_at: now,
  };
}

function prepareDelivery(document: AlertDoc, target: Destination, now: number) {
  const item = scoredItem(document, now);
  const alert: Alert = {
    id: document.alert_id,
    alert_key: "a".repeat(64),
    item_id: item.id,
    analysis_id: "analysis",
    cluster_id: "cluster",
    tier: document.tier,
    kind: document.kind,
    decision: "send",
    decision_reason_json: {
      why_now: document.why_now,
      blocked_by: [],
      importance: null,
      impact: null,
      heat_level: null,
      prior: null,
    },
    created_at: now,
  };
  const [pending] = planDeliveries({
    alert,
    documents: [document],
    destinations: [target],
    itemKind: item.kind,
    now,
    expiresAt: now + 60_000,
    forceDryRun: false,
    ids: { next: () => "delivery" },
  });
  if (pending === undefined) throw new Error("Missing delivery");
  let row: Delivery = pending;
  const claimForSend = vi.fn<DeliveryPorts["deliveries"]["claimForSend"]>(async ({ from, at }) => {
    if (row.state !== from) return { kind: "unavailable" };
    row = { ...row, state: "sending", state_updated_at: at, attempts: row.attempts + 1 };
    return { kind: "claimed", delivery: row };
  });
  const deliveries: DeliveryPorts["deliveries"] = {
    get: async () => row,
    claimForSend,
    transition: async ({ from, to, at, patch }) => {
      if (row.state !== from) return false;
      row = { ...row, ...patch, state: to, state_updated_at: at };
      return true;
    },
  };
  return { alert, item, deliveries, id: pending.id, claimForSend, row: () => row };
}

const model = { provider: "fixture", model: "fixture", max_output_tokens: 50 };
const config = AppConfigSchema.parse({
  models: { triage: model, deep: model, translate: model },
  delivery: { force_dry_run: false },
  retry: { deliver: { max_attempts: 2, backoff_seconds: [1] } },
});
const morning = Date.UTC(2026, 0, 1, 3);

describe("webhook delivery", () => {
  it("bounds escaped Discord text without creating extra links or mentions", () => {
    const noisy = "[plain](https://example.test) <@123> @everyone @here";
    const rendered = renderDiscord({
      ...changelog,
      title: { original: "🚀".repeat(127) + "*".repeat(700), translated: null },
      why_now: `${noisy} ${"why ".repeat(499)}`,
      key_points: [{ text: "Evidence", evidence_quote: "quote ".repeat(166), comment_id: null }],
      engineering_implications: ["*".repeat(2000)],
    });
    const [embed] = rendered.embeds;
    expect(rendered).not.toHaveProperty("content");
    expect(rendered.allowed_mentions).toEqual({ parse: [] });
    expect(embed.title).toBe(`${"🚀".repeat(127)}…`);
    expect(embed.description).toContain(
      "\\[plain\\](h\u200Bttps://example.test) \\<@\u200B123\\> @\u200Beveryone @\u200Bhere",
    );
    expect(embed.description?.length).toBeLessThanOrEqual(4096);
    expect(embed.fields).toHaveLength(2);
    const textLengths = [
      embed.title.length,
      embed.description?.length ?? 0,
      embed.footer?.text.length ?? 0,
    ];
    for (const { name, value } of embed.fields) {
      expect(name.length).toBeLessThanOrEqual(256);
      expect(value.length).toBeLessThanOrEqual(1024);
      expect(value).toMatch(/…$/u);
      textLengths.push(name.length, value.length);
    }
    expect(textLengths.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(6000);
    expect(renderSlack({ ...doc, title: { original: noisy, translated: null } }).text).toContain(
      "&lt;@123&gt;",
    );
  });

  it("omits missing or duplicate prose and preserves the verified translation", () => {
    expect(
      renderDiscord({
        ...doc,
        lang: "ja",
        translation: { machine_translated: true, fell_back_to_english: false },
        title: { original: doc.title.original, translated: "ビルドキャッシュの縮小" },
        why_now: "ビルドキャッシュの縮小",
        key_points: [],
      }).embeds,
    ).toEqual([
      {
        title: "ビルドキャッシュの縮小",
        url: doc.links.source,
        fields: [],
        footer: { text: "Hacker News" },
      },
    ]);
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
    expect(request.redirect).toBe("error");
    expect(await request.json()).toEqual({
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: doc.title.original,
          url: doc.links.source,
          description: doc.why_now,
          fields: [{ name: "HN comment", value: "We shared the cache across Linux jobs." }],
          footer: { text: "Hacker News" },
        },
      ],
    });
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
    { name: "HN", document: doc, rejection: null },
    { name: "changelog", document: changelog, rejection: null },
    { name: "low heat HN", document: doc, rejection: "below_tier" },
    { name: "low prior changelog", document: changelog, rejection: "below_tier" },
    {
      name: "changelog without verified evidence",
      document: changelog,
      rejection: "unverified_content",
    },
    { name: "HN with an unobserved headline URL", document: doc, rejection: "unverified_content" },
    {
      name: "HN after destination language changes",
      document: doc,
      rejection: "unverified_content",
    },
    { name: "stale HN", document: doc, rejection: "expired" },
    { name: "changelog with no source budget", document: changelog, rejection: "budget" },
  ] as const)("selects before sending: $name", async ({ name, document, rejection }) => {
    const { alert, item, deliveries, id, claimForSend, row } = prepareDelivery(
      document,
      destination,
      morning,
    );
    if (name === "low heat HN" && item.score_json?.kind === "hn") item.score_json.level = "H1";
    if (name === "low prior changelog" && item.score_json?.kind === "changelog")
      item.score_json.prior = 39;
    const stored =
      name === "changelog without verified evidence"
        ? { ...document, key_points: [] }
        : name === "HN with an unobserved headline URL"
          ? { ...document, links: { ...document.links, source: "https://another.example/" } }
          : document;
    const requests: Request[] = [];
    const getSecret = vi.fn<() => Promise<string>>(
      async () => "https://discord.com/api/webhooks/123/synthetic",
    );
    const debit = vi.fn<DeliveryPorts["budgets"]["tryConsume"]>(async ({ day, scope, limit }) => ({
      granted: true,
      entry: { day, scope, used: 1, limit },
    }));
    const ports: DeliveryPorts = {
      alerts: { get: async () => alert, getDocument: async () => stored },
      deliveries,
      destinations: {
        get: async () =>
          name === "HN after destination language changes"
            ? { ...destination, lang: "ja" }
            : destination,
      },
      items: { get: async () => item },
      budgets: {
        get: async (day, scope) =>
          name === "changelog with no source budget" && scope === "notify:source:changelog"
            ? { day, scope, used: 5, limit: 5 }
            : null,
        tryConsume: debit,
      },
      clock: { now: () => (name === "stale HN" ? row().expires_at : morning) },
      notifiers: {
        discord: createWebhookNotifier(
          "discord",
          async (request) => {
            requests.push(request);
            return Response.json({ id: "confirmation-1" });
          },
          { get: getSecret },
        ),
        slack: {
          channel: "slack",
          send: async () => {
            throw new Error("Wrong notifier");
          },
        },
      },
    };
    await executeDelivery(ports, id, config);
    await executeDelivery(ports, id, config);
    expect(row()).toMatchObject({
      state: rejection === null ? "sent" : rejection === "expired" ? "expired" : "suppressed",
      suppressed_reason: rejection === "expired" ? null : rejection,
      attempts: rejection === null ? 1 : 0,
      provider_message_id: rejection === null ? "confirmation-1" : null,
    });
    expect(claimForSend).toHaveBeenCalledTimes(rejection === null ? 1 : 0);
    expect(debit).toHaveBeenCalledTimes(rejection === null ? 2 : 0);
    expect(getSecret).toHaveBeenCalledTimes(rejection === null ? 1 : 0);
    const card = {
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: document.title.original,
          url: document.links.source,
          description: document.why_now,
          fields:
            document.item_kind === "hn"
              ? [{ name: "HN comment", value: "We shared the cache across Linux jobs." }]
              : [
                  {
                    name: "Engineering impact",
                    value: "Update the CI cache configuration before upgrading.",
                  },
                  {
                    name: "Source quote",
                    value: "Version 2.0 uses a new cache directory by default.",
                  },
                ],
          footer: { text: document.source_label },
        },
      ],
    };
    const payloads = await Promise.all(
      requests.map(async (request): Promise<unknown> => request.json()),
    );
    expect(payloads).toEqual(rejection === null ? [card] : []);
  });

  it.each([
    ["slack", 500, "unknown", "OUTCOME_UNKNOWN", false],
    ["discord", 503, "unknown", "OUTCOME_UNKNOWN", false],
    ["discord", 429, "failed_retryable", "UPSTREAM_RATE_LIMITED", true],
    ["slack", 400, "failed_permanent", "UPSTREAM_REJECTED", false],
  ] as const)("%s HTTP %i: delivery and replay", async (...scenario) => {
    const [channel, status, state, code, retries] = scenario;
    let now = morning;
    const target = { ...destination, channel };
    const { alert, item, deliveries, id, claimForSend, row } = prepareDelivery(doc, target, now);
    const discard = vi.fn<() => Promise<never>>(() => Promise.reject(new Error("cleanup failed")));
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel: discard }), { status }))
      .mockImplementation(async () => Response.json({ id: "123" }));
    const ports: DeliveryPorts = {
      alerts: { get: async () => alert, getDocument: async () => doc },
      deliveries,
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
    await executeDelivery(ports, id, config);
    expect(row()).toMatchObject({ state, attempts: 1, last_error: { code } });
    expect(discard).toHaveBeenCalledOnce();
    expect(row().next_attempt_at !== null).toBe(retries);

    now += 10_000;
    await executeDelivery(ports, id, config);
    expect(fetch).toHaveBeenCalledTimes(retries ? 2 : 1);
    expect(claimForSend).toHaveBeenCalledTimes(retries ? 2 : 1);
    expect(row().state).toBe(retries ? "sent" : state);
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

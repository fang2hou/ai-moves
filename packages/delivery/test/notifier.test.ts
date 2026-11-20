import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import type { Destination } from "@ai-moves/contracts/entities";
import { describe, expect, it } from "vitest";

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
});

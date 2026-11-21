import { describe, expect, it } from "vitest";

import { redact, REDACTED, redactObject, redactText } from "../src/redact.ts";

describe("redactText", () => {
  const secrets: readonly (readonly [string, string])[] = [
    ["a Slack webhook", "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX"],
    ["a Discord webhook", "https://discord.com/api/webhooks/123456789/abcdefTOKEN"],
    ["a versioned Discord webhook", "https://discord.com/api/v10/webhooks/123456789/abcdefTOKEN"],
    ["a legacy Discord webhook", "https://discordapp.com/api/webhooks/123456789/abcdefTOKEN"],
    ["a bearer token", "Bearer abc.def-ghi_jkl"],
    ["a GitHub classic token", "ghp_0123456789abcdefghijABCDEFGHIJ012345"],
    ["a GitHub fine-grained token", "github_pat_0123456789abcdefghij_ABCDEFGHIJ"],
    ["a provider API key", "sk-or-v1-0123456789abcdef0123456789abcdef"],
    ["a Slack bot token", "xoxb-0123456789-abcdefghij"],
  ];

  it.each(secrets)("removes %s", (_name, secret) => {
    const text = redactText(`request to ${secret} failed`);
    expect(text).toBe(`request to ${REDACTED} failed`);
  });

  it("removes credentials embedded in a URL but keeps the host", () => {
    expect(redactText("GET https://user:hunter2@example.com/path")).toBe(
      `GET https://${REDACTED}@example.com/path`,
    );
  });

  it("leaves ordinary text and public URLs alone", () => {
    const text = "GET https://api.github.com/repos/o/r/releases returned 304";
    expect(redactText(text)).toBe(text);
  });

  it("truncates long text so a full prompt cannot be logged", () => {
    const text = redactText("p".repeat(5000));
    expect(text.length).toBeLessThan(2100);
    expect(text.endsWith("...[truncated]")).toBe(true);
  });
});

describe("redact", () => {
  it("replaces values under sensitive keys at any depth", () => {
    expect(
      redact({
        destination: "slack-main",
        webhook_url: "https://example.com/hook",
        headers: { Authorization: "Basic abc", accept: "application/json" },
        nested: [{ api_key: "k", apiKey: "k", token: "t", prompt: "full prompt", messages: [] }],
      }),
    ).toEqual({
      destination: "slack-main",
      webhook_url: REDACTED,
      headers: { Authorization: REDACTED, accept: "application/json" },
      nested: [
        {
          api_key: REDACTED,
          apiKey: REDACTED,
          token: REDACTED,
          prompt: REDACTED,
          messages: REDACTED,
        },
      ],
    });
  });

  it("scrubs secrets inside string values under harmless keys", () => {
    expect(redact({ note: "sent to https://hooks.slack.com/services/T/B/X" })).toEqual({
      note: `sent to ${REDACTED}`,
    });
  });

  it("produces JSON-safe output for values JSON cannot represent", () => {
    const value = redact({
      big: 10n,
      missing: undefined,
      fn: () => 1,
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      when: new Date(0),
      ok: true,
      none: null,
    });
    expect(value).toEqual({
      big: "10",
      nan: "NaN",
      infinite: "Infinity",
      when: {},
      ok: true,
      none: null,
    });
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });

  it("bounds depth and array length", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } } };
    expect(JSON.stringify(redact(deep))).toContain("[depth limit]");
    expect(JSON.stringify(redact(deep))).not.toContain("too deep");
    const long = redact(Array.from({ length: 80 }, (_value, index) => index));
    expect(Array.isArray(long) && long.length).toBe(50);
  });

  it("returns an object from redactObject", () => {
    expect(redactObject({ password: "p", user: "u" })).toEqual({ password: REDACTED, user: "u" });
  });
});

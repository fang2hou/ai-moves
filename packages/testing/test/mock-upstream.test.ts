import { isAppError } from "@ai-moves/kernel/errors/app-error";
import { withTimeout } from "@ai-moves/kernel/timeout";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadFixture } from "../src/node/fixtures.ts";
import { createMockUpstream, MOCK_FAULTS } from "../src/upstream/mock-upstream.ts";

const RELEASES = "https://api.github.com/repos/example-org/example-cli/releases";

async function settle(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createMockUpstream", () => {
  it("answers a scripted route and records the request", async () => {
    const upstream = createMockUpstream();
    upstream.on("POST", "https://hooks.example/post").reply(200, { ok: true });

    const response = await upstream.fetch(
      new Request("https://hooks.example/post", {
        method: "POST",
        headers: { "content-type": "application/json", "x-trace": "trace_1" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true });
    expect(upstream.requests).toEqual([
      {
        method: "POST",
        url: "https://hooks.example/post",
        headers: { "content-type": "application/json", "x-trace": "trace_1" },
        body: '{"text":"hello"}',
      },
    ]);
  });

  it("rejects an unscripted request and keeps it for inspection", async () => {
    const upstream = createMockUpstream();
    upstream.on("GET", RELEASES).reply(200, []);

    const error = await settle(upstream.fetch(new Request(RELEASES, { method: "POST" })));

    expect(error).toBeInstanceOf(TypeError);
    expect(upstream.requests).toEqual([]);
    expect(upstream.unexpected.map((request) => `${request.method} ${request.url}`)).toEqual([
      `POST ${RELEASES}`,
    ]);
  });

  it("consumes one-shot replies in order before the standing reply", async () => {
    const upstream = createMockUpstream();
    upstream
      .on("GET", RELEASES)
      .replyOnce(200, [{ tag: "v1" }], { etag: '"a"' })
      .replyOnce(304)
      .reply(500, "down");

    const statuses: number[] = [];
    for (let call = 0; call < 4; call += 1) {
      statuses.push((await upstream.fetch(new Request(RELEASES))).status);
    }

    expect(statuses).toEqual([200, 304, 500, 500]);
    expect(upstream.pendingScripts()).toBe(0);
  });

  it("reports scripts that were never consumed", () => {
    const upstream = createMockUpstream();
    upstream.on("GET", RELEASES).replyOnce(200, []).failNext("server_error", { times: 2 });
    expect(upstream.pendingScripts()).toBe(3);
  });

  it("matches by exact url, by url without query, by pattern, and by predicate", async () => {
    const upstream = createMockUpstream();
    upstream.on("GET", `${RELEASES}?per_page=10`).reply(200, "exact");
    upstream.on("GET", "https://hacker-news.firebaseio.com/v0/topstories.json").reply(200, "path");
    upstream.on("GET", /\/v0\/item\/\d+\.json$/).reply(200, "pattern");
    upstream.on("GET", (url) => url.hostname === "hn.algolia.com").reply(200, "predicate");

    const bodies: string[] = [];
    for (const url of [
      `${RELEASES}?per_page=10`,
      "https://hacker-news.firebaseio.com/v0/topstories.json?print=pretty",
      "https://hacker-news.firebaseio.com/v0/item/8863.json",
      "https://hn.algolia.com/api/v1/items/8863",
    ]) {
      bodies.push(await (await upstream.fetch(new Request(url))).text());
    }

    expect(bodies).toEqual(["exact", "path", "pattern", "predicate"]);
    expect(upstream.requestsTo(/firebaseio/)).toHaveLength(2);
  });

  it("matches repeatedly when a global or sticky pattern matcher is reused", async () => {
    const upstream = createMockUpstream();
    upstream.on("GET", /\/items\/\d+$/g).reply(200, "match");

    expect(await (await upstream.fetch(new Request("https://example.test/items/1"))).text()).toBe(
      "match",
    );
    expect(await (await upstream.fetch(new Request("https://example.test/items/2"))).text()).toBe(
      "match",
    );
  });

  it("lets a responder compute the reply from the request", async () => {
    const upstream = createMockUpstream();
    upstream.on("GET", RELEASES).replyWith((request) => {
      const notModified = request.headers.get("if-none-match") === '"a"';
      return new Response(notModified ? null : "[]", { status: notModified ? 304 : 200 });
    });

    const fresh = await upstream.fetch(new Request(RELEASES));
    const cached = await upstream.fetch(
      new Request(RELEASES, { headers: { "if-none-match": '"a"' } }),
    );

    expect([fresh.status, cached.status]).toEqual([200, 304]);
  });

  it("replays a fixture", async () => {
    const upstream = createMockUpstream();
    upstream.replay(loadFixture("_example", "ok"));

    const response = await upstream.fetch(new Request("https://upstream.example/v1/things/1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('W/"example"');
    expect(await response.json()).toEqual({ id: 1, name: "example" });
  });

  it("forgets routes and history on reset", async () => {
    const upstream = createMockUpstream();
    upstream.on("GET", RELEASES).reply(200, []);
    await upstream.fetch(new Request(RELEASES));
    upstream.reset();

    expect(upstream.requests).toEqual([]);
    expect(await settle(upstream.fetch(new Request(RELEASES)))).toBeInstanceOf(TypeError);
  });
});

describe("fault injection", () => {
  it("covers every declared fault", () => {
    expect(MOCK_FAULTS.toSorted()).toEqual([
      "connection_error",
      "malformed_body",
      "rate_limited",
      "server_error",
      "timeout",
    ]);
  });

  it("fails the next requests first and then recovers", async () => {
    const upstream = createMockUpstream();
    upstream.on("GET", RELEASES).reply(200, []).failNext("server_error", { times: 2 });

    const statuses: number[] = [];
    for (let call = 0; call < 3; call += 1) {
      statuses.push((await upstream.fetch(new Request(RELEASES))).status);
    }

    expect(statuses).toEqual([503, 503, 200]);
  });

  it("returns 429 with a retry-after header", async () => {
    const upstream = createMockUpstream();
    upstream.on("POST", "https://hooks.example/post").failNext("rate_limited", {
      retryAfterSeconds: 7,
    });

    const response = await upstream.fetch(
      new Request("https://hooks.example/post", { method: "POST" }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
  });

  it("returns a success status with a body that is not valid JSON", async () => {
    const upstream = createMockUpstream();
    upstream.on("GET", RELEASES).failNext("malformed_body");

    const response = await upstream.fetch(new Request(RELEASES));

    expect(response.status).toBe(200);
    expect(await settle(response.json())).toBeInstanceOf(SyntaxError);
  });

  it("rejects like a dropped connection", async () => {
    const upstream = createMockUpstream();
    upstream.on("GET", RELEASES).failNext("connection_error");

    const error = await settle(upstream.fetch(new Request(RELEASES)));

    expect(error).toBeInstanceOf(TypeError);
    expect(upstream.requests).toHaveLength(1);
  });

  it("never answers until the caller's deadline aborts the request", async () => {
    vi.useFakeTimers();
    const upstream = createMockUpstream();
    upstream.on("GET", RELEASES).failNext("timeout");

    const pending = settle(
      withTimeout((signal) => upstream.fetch(new Request(RELEASES, { signal })), {
        timeoutMs: 10_000,
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await pending;

    expect(isAppError(error) && error.code).toBe("UPSTREAM_TIMEOUT");
    expect(isAppError(error) && error.kind).toBe("retryable");
  });
});

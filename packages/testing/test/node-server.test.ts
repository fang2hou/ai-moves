import { request } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { loadFixture } from "../src/node/fixtures.ts";
import { listenMockUpstream, type MockUpstreamServer } from "../src/node/server.ts";
import { createMockUpstream } from "../src/upstream/mock-upstream.ts";

interface HttpResult {
  readonly status: number | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

// The shared test setup disables global fetch, so the loopback call uses node:http directly.
function call(url: string, method: string, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

let server: MockUpstreamServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("listenMockUpstream", () => {
  it("serves the mock on a loopback port, rewriting requests to the scripted origin", async () => {
    const upstream = createMockUpstream();
    upstream.replay(loadFixture("_example", "ok"));
    upstream.on("POST", "https://upstream.example/v1/things").replyWith(async (incoming) => {
      const text = await incoming.text();
      return new Response(text.toUpperCase(), { status: 201 });
    });
    server = await listenMockUpstream(upstream, { origin: "https://upstream.example" });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const fetched = await call(`${server.url}/v1/things/1`, "GET");
    const posted = await call(`${server.url}/v1/things`, "POST", "created");

    expect(fetched.status).toBe(200);
    expect(fetched.headers["etag"]).toBe('W/"example"');
    expect(JSON.parse(fetched.body)).toEqual({ id: 1, name: "example" });
    expect(posted).toMatchObject({ status: 201, body: "CREATED" });
    expect(upstream.requests.map((entry) => entry.url)).toEqual([
      "https://upstream.example/v1/things/1",
      "https://upstream.example/v1/things",
    ]);
  });

  it("passes injected HTTP faults through", async () => {
    const upstream = createMockUpstream();
    upstream.on("GET", "https://upstream.example/v1/things/1").failNext("rate_limited", {
      retryAfterSeconds: 3,
    });
    server = await listenMockUpstream(upstream, { origin: "https://upstream.example" });

    const limited = await call(`${server.url}/v1/things/1`, "GET");

    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("3");
  });

  it("drops the connection for an unscripted request", async () => {
    const upstream = createMockUpstream();
    server = await listenMockUpstream(upstream, { origin: "https://upstream.example" });

    await expect(call(`${server.url}/nowhere`, "GET")).rejects.toMatchObject({
      code: "ECONNRESET",
    });
    expect(upstream.unexpected.map((entry) => entry.url)).toEqual([
      "https://upstream.example/nowhere",
    ]);
  });
});

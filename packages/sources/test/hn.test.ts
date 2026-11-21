import type { HttpFetch } from "@ai-moves/contracts/ports/runtime";
import { loadFixture } from "@ai-moves/testing/node/fixtures";
import { createMockUpstream } from "@ai-moves/testing/upstream/mock-upstream";
import { describe, expect, it, vi } from "vitest";

import { createHnClient } from "../src/hn.ts";

const TOP = "https://hacker-news.firebaseio.com/v0/topstories.json";
const item = (id: number): string => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

function comment(id: number, parent: number, kids: readonly number[], text = `comment ${id}`) {
  return { id, type: "comment", parent, time: 1_760_000_001, text, kids };
}

describe("Hacker News client", () => {
  it("normalizes official ranked IDs and story fields without exposing tombstones", async () => {
    const mock = createMockUpstream();
    for (const name of ["top-stories", "ask-story", "deleted-story", "dead-story"]) {
      mock.replay(loadFixture("hn", name));
    }
    mock.on("GET", item(99)).reply(200, "null", { "content-type": "application/json" });
    const client = createHnClient({ fetch: mock.fetch });

    await expect(client.listTopStoryIds()).resolves.toEqual([41, 12, 98]);
    await expect(client.getStory(41)).resolves.toEqual({
      id: 41,
      type: "story",
      title: "Ask HN: What are you building?",
      url: null,
      text: "Tell us about it.<p>Examples welcome.",
      author: "example_author",
      points: 17,
      comments: 4,
      published_at: 1_760_000_000_000,
      deleted: false,
      dead: false,
    });
    await expect(client.getStory(12)).resolves.toBeNull();
    await expect(client.getStory(98)).resolves.toBeNull();
    await expect(client.getStory(99)).resolves.toBeNull();
  });

  it("preserves comment display order and visible descendants while bounding depth and duplicate requests", async () => {
    const mock = createMockUpstream();
    mock.replay(loadFixture("hn", "ask-story"));
    mock.on("GET", item(42)).reply(200, { id: 42, deleted: true, kids: [44] });
    mock.on("GET", item(43)).reply(200, comment(43, 41, [43]));
    mock.on("GET", item(44)).reply(200, comment(44, 42, [45, 45]));
    mock.on("GET", item(45)).reply(200, comment(45, 44, [46], "x".repeat(801)));
    const client = createHnClient({ fetch: mock.fetch });

    const tree = await client.getCommentTree(41);
    expect(tree.comments.map(({ id, parent_id: parent, depth }) => [id, parent, depth])).toEqual([
      [44, 42, 1],
      [45, 44, 2],
      [43, 41, 0],
    ]);
    expect(tree.comments[1]?.text).toBe("x".repeat(800));
    expect(mock.requests.map(({ url }) => url)).toEqual([41, 42, 43, 44, 45].map(item));
    expect(mock.unexpected).toEqual([]);
  });

  it("rejects malformed ranked data, mismatched story IDs, and incomplete live stories", async () => {
    const mock = createMockUpstream();
    mock.on("GET", TOP).reply(200, [41, "42"]);
    mock.on("GET", item(41)).reply(200, { id: 40, deleted: true });
    mock.on("GET", item(42)).reply(200, { id: 42, type: "story", time: 1_760_000_000 });
    const client = createHnClient({ fetch: mock.fetch });

    await expect(client.listTopStoryIds()).rejects.toMatchObject({
      code: "UPSTREAM_RESPONSE_INVALID",
    });
    await expect(client.getStory(41)).rejects.toMatchObject({ code: "UPSTREAM_RESPONSE_INVALID" });
    await expect(client.getStory(42)).rejects.toMatchObject({ code: "UPSTREAM_RESPONSE_INVALID" });
    await expect(client.getStory(0)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(mock.unexpected).toEqual([]);
  });

  it.each([
    ["malformed_body", "UPSTREAM_RESPONSE_INVALID"],
    ["server_error", "UPSTREAM_UNAVAILABLE"],
    ["connection_error", "UPSTREAM_UNAVAILABLE"],
    ["rate_limited", "UPSTREAM_RATE_LIMITED"],
  ] as const)("classifies %s", async (fault, code) => {
    const mock = createMockUpstream();
    mock.on("GET", TOP).failNext(fault);
    await expect(createHnClient({ fetch: mock.fetch }).listTopStoryIds()).rejects.toMatchObject({
      code,
    });
  });

  it("aborts a stalled request and classifies the deadline", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn<HttpFetch>(() => new Promise<Response>(() => undefined));
      const work = createHnClient({ fetch: transport, timeoutMs: 15 }).listTopStoryIds();
      await Promise.all([
        expect(work).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" }),
        vi.advanceTimersByTimeAsync(15),
      ]);
      expect(transport.mock.calls[0]?.[0].signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

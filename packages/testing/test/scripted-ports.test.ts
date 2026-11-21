import type { GenerateStructuredRequest } from "@ai-moves/contracts/ports/llm";
import type { HnStory, WebDocument } from "@ai-moves/contracts/ports/sources";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { createScriptedGitHubClient } from "@ai-moves/testing/fakes/github";
import { createScriptedHnClient } from "@ai-moves/testing/fakes/hn";
import { createScriptedLlmClient } from "@ai-moves/testing/fakes/llm";
import { createScriptedWebFetcher } from "@ai-moves/testing/fakes/web";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("scripted LLM", () => {
  it("consumes failures and results in call order and validates with the caller's generic schema", async () => {
    const failure = new AppError("UPSTREAM_RATE_LIMITED", { retryAfterMs: 100 });
    const result = {
      model: "model-test",
      usage: { input_tokens: 50, output_tokens: 5, cost_usd: null },
      repaired: true,
      usedFallback: false,
    };
    const client = createScriptedLlmClient([
      { kind: "reject", error: failure },
      { kind: "return", value: { ...result, output: { score: 3, unexpected: true } } },
      { kind: "return", value: { ...result, output: { score: 4 } } },
    ]);
    const request: GenerateStructuredRequest<number> = {
      stage: "deep",
      schemaName: "score",
      schema: z.strictObject({ score: z.int() }).transform(({ score }) => score),
      traceId: "trace_1",
      messages: [{ role: "user", content: "Rate the example." }],
    };

    await expect(client.generateStructured(request)).rejects.toBe(failure);
    await expect(client.generateStructured(request)).rejects.toMatchObject({
      code: "LLM_OUTPUT_INVALID",
      kind: "validation",
    });
    await expect(client.generateStructured(request)).resolves.toEqual({ ...result, output: 4 });
    await expect(client.generateStructured(request)).rejects.toMatchObject({
      message: "Unscripted LlmClient.generateStructured call",
    });
    expect(client.calls.map(([call]) => call.traceId)).toEqual(Array<string>(4).fill("trace_1"));
  });
});

describe("scripted source clients", () => {
  it("scripts ranked stories, a missing story, and comment failures independently", async () => {
    const story: HnStory = {
      id: 2,
      type: "story",
      title: "Example",
      url: null,
      text: "Example story",
      author: null,
      points: 10,
      comments: 0,
      published_at: 100,
      deleted: false,
      dead: false,
    };
    const timeout = new AppError("UPSTREAM_TIMEOUT");
    const client = createScriptedHnClient({
      listTopStoryIds: [{ kind: "return", value: [2, 1] }],
      getStory: [
        { kind: "return", value: story },
        { kind: "return", value: null },
      ],
      getCommentTree: [
        { kind: "reject", error: timeout },
        { kind: "return", value: { story_id: 2, comments: [] } },
      ],
    });

    await expect(client.listTopStoryIds()).resolves.toEqual([2, 1]);
    await expect(client.getCommentTree(2)).rejects.toBe(timeout);
    await expect(client.getStory(2)).resolves.toEqual(story);
    await expect(client.getStory(1)).resolves.toBeNull();
    await expect(client.getCommentTree(2)).resolves.toEqual({ story_id: 2, comments: [] });
    expect(client.calls).toEqual({
      listTopStoryIds: [[]],
      getStory: [[2], [1]],
      getCommentTree: [[2], [2]],
    });
  });

  it("separates conditional GitHub results from missing files and keeps the requested ETags", async () => {
    const repo = { owner: "example", repo: "cli" };
    const initial = { etag: null };
    const cached = { etag: '"releases-1"' };
    const compare = {
      base: "v1",
      head: "v2",
      commit_messages: ["Add test command"],
      url: "https://example.test/v1...v2",
    };
    const client = createScriptedGitHubClient({
      listReleases: [
        { kind: "return", value: { status: "modified", etag: cached.etag, value: [] } },
        { kind: "return", value: { status: "not_modified" } },
      ],
      listTags: [
        {
          kind: "return",
          value: { status: "modified", etag: null, value: [{ name: "v2", commit_sha: "abc" }] },
        },
      ],
      getFile: [{ kind: "return", value: { status: "modified", etag: null, value: null } }],
      compare: [{ kind: "return", value: compare }],
    });

    await expect(client.listReleases(repo, initial)).resolves.toEqual({
      status: "modified",
      etag: cached.etag,
      value: [],
    });
    await expect(client.listReleases(repo, cached)).resolves.toEqual({ status: "not_modified" });
    await expect(client.listTags(repo, initial)).resolves.toMatchObject({
      status: "modified",
      value: [{ name: "v2", commit_sha: "abc" }],
    });
    await expect(client.getFile(repo, "CHANGELOG.md", initial)).resolves.toEqual({
      status: "modified",
      etag: null,
      value: null,
    });
    await expect(client.compare(repo, "v1", "v2")).resolves.toEqual(compare);
    expect(client.calls).toEqual({
      listReleases: [
        [repo, initial],
        [repo, cached],
      ],
      listTags: [[repo, initial]],
      getFile: [[repo, "CHANGELOG.md", initial]],
      compare: [[repo, "v1", "v2"]],
    });
  });

  it("replays classified web failures and documents without reaching global fetch", async () => {
    const failure = new AppError("CONTENT_UNSUPPORTED");
    const document: WebDocument = {
      requested_url: "https://example.test/post",
      final_url: "https://example.test/post/1",
      content_type: "text/plain",
      text: "Example content",
      truncated: false,
      content_hash: "a".repeat(64),
    };
    const web = createScriptedWebFetcher([
      { kind: "reject", error: failure },
      { kind: "return", value: document },
    ]);
    const binary = "https://example.test/file.zip";
    await expect(web.fetchText(binary)).rejects.toBe(failure);
    await expect(web.fetchText(document.requested_url)).resolves.toEqual(document);
    await expect(web.fetchText("https://example.test/unstubbed")).rejects.toMatchObject({
      code: "INPUT_INVALID",
    });
    expect(web.calls).toEqual([
      [binary],
      [document.requested_url],
      ["https://example.test/unstubbed"],
    ]);
  });
});

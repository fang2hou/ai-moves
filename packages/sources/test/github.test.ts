import type { HttpFetch } from "@ai-moves/contracts/ports/runtime";
import { loadFixture } from "@ai-moves/testing/node/fixtures";
import { createMockUpstream } from "@ai-moves/testing/upstream/mock-upstream";
import { describe, expect, it, vi } from "vitest";

import { createGitHubClient } from "../src/github.ts";

const REPO = { owner: "example", repo: "tool" };
const API = "https://api.github.com/repos/example/tool";
const NO_ETAG = { etag: null };
const CHANGELOG = "docs/CHANGELOG.md";

describe("GitHub client", () => {
  it("normalizes releases, tags, changelog content, and compare messages", async () => {
    const mock = createMockUpstream();
    for (const name of ["releases", "tags", "changelog", "compare"]) {
      mock.replay(loadFixture("github", name));
    }
    const client = createGitHubClient({ fetch: mock.fetch });

    await expect(client.listReleases(REPO, NO_ETAG)).resolves.toEqual({
      status: "modified",
      etag: 'W/"releases-1"',
      value: [
        {
          tag: "v2.0.0-rc.1",
          name: null,
          body: "## Preview",
          draft: false,
          prerelease: true,
          published_at: 1_760_000_000_000,
          url: "https://github.com/example/tool/releases/tag/v2.0.0-rc.1",
        },
      ],
    });
    await expect(client.listTags(REPO, NO_ETAG)).resolves.toEqual({
      status: "modified",
      etag: '"tags-1"',
      value: [{ name: "v2.0.0-rc.1", commit_sha: "01abcd" }],
    });
    await expect(client.getFile(REPO, CHANGELOG, NO_ETAG)).resolves.toEqual({
      status: "modified",
      etag: '"changes-1"',
      value: { path: CHANGELOG, sha: "02abcd", text: "# Changes\n" },
    });
    await expect(client.compare(REPO, "v1.0.0", "release/v2.0.0")).resolves.toEqual({
      base: "v1.0.0",
      head: "release/v2.0.0",
      url: "https://github.com/example/tool/compare/v1.0.0...release/v2.0.0",
      commit_messages: ["Add a build command", "Document the build command"],
    });
    expect(mock.requests.every(({ headers }) => headers["if-none-match"] === undefined)).toBe(true);
  });

  it("uses the exact supplied ETag on each conditional endpoint and does not read a 304 body", async () => {
    const transport = vi.fn<HttpFetch>((request) =>
      Promise.resolve(
        new Response(null, {
          status: request.headers.get("if-none-match") === 'W/"cached version"' ? 304 : 412,
        }),
      ),
    );
    const client = createGitHubClient({ fetch: transport });
    const etag = { etag: 'W/"cached version"' };

    await expect(client.listReleases(REPO, etag)).resolves.toEqual({ status: "not_modified" });
    await expect(client.listTags(REPO, etag)).resolves.toEqual({ status: "not_modified" });
    await expect(client.getFile(REPO, CHANGELOG, etag)).resolves.toEqual({
      status: "not_modified",
    });
    await expect(client.listTags(REPO, NO_ETAG)).rejects.toMatchObject({
      code: "UPSTREAM_REJECTED",
    });
    expect(transport.mock.calls.map(([request]) => request.url)).toEqual([
      `${API}/releases?per_page=10`,
      `${API}/tags?per_page=10`,
      `${API}/contents/${CHANGELOG}`,
      `${API}/tags?per_page=10`,
    ]);
  });

  it("maps missing files to null without treating a missing listing as unchanged", async () => {
    const mock = createMockUpstream();
    mock.on("GET", `${API}/contents/${CHANGELOG}`).reply(404, { message: "Not Found" });
    mock.on("GET", `${API}/tags?per_page=10`).reply(404, { message: "Not Found" });
    const client = createGitHubClient({ fetch: mock.fetch });
    await expect(client.getFile(REPO, CHANGELOG, { etag: '"old"' })).resolves.toEqual({
      status: "modified",
      etag: null,
      value: null,
    });
    await expect(client.listTags(REPO, NO_ETAG)).rejects.toMatchObject({
      code: "UPSTREAM_REJECTED",
      context: { status: 404 },
    });
  });

  it("follows same-origin redirects without allowing credentials to leave api.github.com", async () => {
    const calls: [string, string | null, Request["redirect"]][] = [];
    const client = createGitHubClient({
      token: "example-value",
      fetch: (request) => {
        calls.push([request.url, request.headers.get("authorization"), request.redirect]);
        const location =
          calls.length === 1 ? "/repositories/123/tags?per_page=10" : "https://other.example/tags";
        return Promise.resolve(new Response(null, { status: 301, headers: { location } }));
      },
    });

    await expect(client.listTags(REPO, NO_ETAG)).rejects.toMatchObject({
      code: "HOST_NOT_ALLOWED",
    });
    expect(calls).toEqual([
      [`${API}/tags?per_page=10`, "Bearer example-value", "manual"],
      [
        "https://api.github.com/repositories/123/tags?per_page=10",
        "Bearer example-value",
        "manual",
      ],
    ]);
  });

  it("rejects malformed lists, invalid base64, and unsupported directories", async () => {
    const mock = createMockUpstream();
    mock.on("GET", `${API}/releases?per_page=10`).reply(200, [{ tag_name: "v1" }]);
    mock.on("GET", `${API}/tags?per_page=10`).reply(200, [{ name: "v1", commit: {} }]);
    mock.on("GET", `${API}/contents/${CHANGELOG}`).reply(200, {
      type: "file",
      encoding: "base64",
      path: CHANGELOG,
      sha: "abc",
      size: 3,
      content: "?!",
    });
    mock.on("GET", `${API}/contents/docs`).reply(200, [{ type: "file" }]);
    const client = createGitHubClient({ fetch: mock.fetch });

    await expect(client.listReleases(REPO, NO_ETAG)).rejects.toMatchObject({
      code: "UPSTREAM_RESPONSE_INVALID",
    });
    await expect(client.listTags(REPO, NO_ETAG)).rejects.toMatchObject({
      code: "UPSTREAM_RESPONSE_INVALID",
    });
    await expect(client.getFile(REPO, CHANGELOG, NO_ETAG)).rejects.toMatchObject({
      code: "UPSTREAM_RESPONSE_INVALID",
    });
    await expect(client.getFile(REPO, "docs", NO_ETAG)).rejects.toMatchObject({
      code: "CONTENT_UNSUPPORTED",
    });
    await expect(client.getFile(REPO, "../CHANGELOG.md", NO_ETAG)).rejects.toMatchObject({
      code: "INPUT_INVALID",
    });
    expect(mock.unexpected).toEqual([]);
  });

  it.each([
    {
      status: 429,
      headers: { "retry-after": "3" },
      message: "Slow down",
      code: "UPSTREAM_RATE_LIMITED",
      retryAfterMs: 3_000,
    },
    {
      status: 403,
      headers: {},
      message: "You have exceeded a secondary rate limit.",
      code: "UPSTREAM_RATE_LIMITED",
      retryAfterMs: undefined,
    },
    {
      status: 403,
      headers: {
        date: "Thu, 09 Oct 2025 08:53:20 GMT",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1760000060",
      },
      message: "Rate limit",
      code: "UPSTREAM_RATE_LIMITED",
      retryAfterMs: 60_000,
    },
    {
      status: 403,
      headers: {},
      message: "Forbidden",
      code: "UPSTREAM_REJECTED",
      retryAfterMs: undefined,
    },
    {
      status: 503,
      headers: {},
      message: "Maintenance",
      code: "UPSTREAM_UNAVAILABLE",
      retryAfterMs: undefined,
    },
  ])(
    "classifies HTTP $status $message",
    async ({ status, headers, message, code, retryAfterMs }) => {
      const mock = createMockUpstream();
      mock
        .on("GET", `${API}/tags?per_page=10`)
        .reply(
          status,
          { message },
          Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)),
        );
      const client = createGitHubClient({ fetch: mock.fetch });
      await expect(client.listTags(REPO, NO_ETAG)).rejects.toMatchObject({ code, retryAfterMs });
    },
  );
});

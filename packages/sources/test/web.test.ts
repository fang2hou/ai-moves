import { loadFixture } from "@ai-moves/testing/node/fixtures";
import { createMockUpstream } from "@ai-moves/testing/upstream/mock-upstream";
import { describe, expect, it, vi } from "vitest";

import { createWebFetcher, type WebFetcherOptions } from "../src/web.ts";

type Resolve = WebFetcherOptions["resolve"];
type FetchPinned = WebFetcherOptions["fetchPinned"];

const URL = "https://article.example/old";
const PUBLIC = "93.184.216.34";
const PUBLIC_V6 = "2606:4700:4700::1111";
const publicResolution = () => Promise.resolve([PUBLIC]);
const plain = (text: string | ReadableStream<Uint8Array>): Response =>
  new Response(text, { headers: { "content-type": "text/plain" } });

describe("protected web fetch", () => {
  it("resolves and pins each redirect target, extracts HTML text, and hashes the result", async () => {
    const mock = createMockUpstream();
    mock.replay(loadFixture("web", "article-redirect"));
    mock.replay(loadFixture("web", "article-html"));
    const resolve = vi.fn<Resolve>((host) =>
      Promise.resolve(host === "article.example" ? [PUBLIC] : [PUBLIC_V6]),
    );
    const fetchPinned = vi.fn<FetchPinned>(({ request }) => mock.fetch(request));
    const web = createWebFetcher({ resolve, fetchPinned });

    await expect(web.fetchText(`${URL}#ignored`)).resolves.toEqual({
      requested_url: URL,
      final_url: "https://content.example/article",
      content_type: "text/html",
      text: "Hello & welcome. Build 🛠 now.",
      truncated: false,
      content_hash: "268a639f9fabc1f1667a9d0e61e5a1277813404ebb22ec35579f1d6c2241addb",
    });
    expect(resolve.mock.calls).toEqual([
      ["article.example", expect.any(AbortSignal)],
      ["content.example", expect.any(AbortSignal)],
    ]);
    expect(
      fetchPinned.mock.calls.map(([{ address, request }]) => ({
        address,
        method: request.method,
        redirect: request.redirect,
        credentials: request.credentials,
        authorization: request.headers.get("authorization"),
        cookie: request.headers.get("cookie"),
      })),
    ).toEqual(
      [PUBLIC, PUBLIC_V6].map((address) => ({
        address,
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        authorization: null,
        cookie: null,
      })),
    );
  });

  it.each([
    "http://article.example/",
    "ftp://article.example/",
    "https://article.example:8443/",
    "https://user:password@article.example/",
    "https://user@article.example/",
    "https://@article.example/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://93.184.216.34/",
    "https://article.localhost./",
    "https://child.denied.example./",
  ])("rejects %s before resolution or transport", async (input) => {
    const resolve = vi.fn<Resolve>(publicResolution);
    const fetchPinned = vi.fn<FetchPinned>(() => Promise.resolve(plain("unexpected")));
    const web = createWebFetcher({
      resolve,
      fetchPinned,
      config: { denied_domains: ["DENIED.example"] },
    });
    await expect(web.fetchText(input)).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    expect(resolve).not.toHaveBeenCalled();
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it.each([
    "10.1.2.3",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.1.1",
    "192.168.1.1",
    "100.64.1.1",
    "224.0.0.1",
    "0.0.0.0",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "not-an-address",
  ])("rejects a DNS answer that mixes a public address with %s", async (address) => {
    const fetchPinned = vi.fn<FetchPinned>(() => Promise.resolve(plain("unexpected")));
    const web = createWebFetcher({
      resolve: () => Promise.resolve([PUBLIC, address]),
      fetchPinned,
    });
    await expect(web.fetchText(URL)).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("rejects a private redirect literal before issuing another DNS or HTTP request", async () => {
    const fetchPinned = vi.fn<FetchPinned>(() =>
      Promise.resolve(
        new Response(null, { status: 301, headers: { location: "https://169.254.1.1/" } }),
      ),
    );
    const resolve = vi.fn<Resolve>(publicResolution);
    await expect(createWebFetcher({ resolve, fetchPinned }).fetchText(URL)).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(fetchPinned).toHaveBeenCalledTimes(1);
  });

  it("does not reuse DNS answers when a same-host redirect changes the answer set", async () => {
    const resolve = vi
      .fn<Resolve>(publicResolution)
      .mockResolvedValueOnce([PUBLIC, PUBLIC_V6])
      .mockResolvedValueOnce(["192.168.0.4"]);
    const fetchPinned = vi.fn<FetchPinned>(() =>
      Promise.resolve(new Response(null, { status: 307, headers: { location: "/next" } })),
    );
    const web = createWebFetcher({ resolve, fetchPinned });
    await expect(web.fetchText(URL)).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(fetchPinned).toHaveBeenCalledTimes(1);
  });

  it("accepts exactly 32 public answers and rejects an overflow on redirect", async () => {
    const fullSet = Array<string>(31).fill(PUBLIC);
    fullSet.push(PUBLIC_V6);
    const resolve = vi
      .fn<Resolve>()
      .mockResolvedValueOnce(fullSet)
      .mockResolvedValueOnce([...fullSet, PUBLIC]);
    const fetchPinned = vi.fn<FetchPinned>(() =>
      Promise.resolve(new Response(null, { status: 307, headers: { location: "/next" } })),
    );
    const web = createWebFetcher({ resolve, fetchPinned });
    await expect(web.fetchText(URL)).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
      message: "Web DNS answer limit exceeded",
    });
    const [initial, redirected] = resolve.mock.calls;
    expect(initial?.[1]).toBe(redirected?.[1]);
    expect(fetchPinned.mock.calls.map(([{ address, request }]) => [request.url, address])).toEqual([
      [URL, PUBLIC],
    ]);
  });

  it("bounds the redirect chain and never requests the target beyond the limit", async () => {
    const fetchPinned = vi.fn<FetchPinned>(({ request }) =>
      Promise.resolve(
        new Response(null, { status: 308, headers: { location: `${request.url}/next` } }),
      ),
    );
    const web = createWebFetcher({
      resolve: publicResolution,
      fetchPinned,
      config: { max_redirects: 1 },
    });
    await expect(web.fetchText(URL)).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    expect(fetchPinned.mock.calls.map(([{ request }]) => request.url)).toEqual([
      URL,
      `${URL}/next`,
    ]);
  });

  it("stops an oversized stream at the configured UTF-8 byte boundary and cancels it", async () => {
    const cancel = vi.fn<() => void>();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3]));
        controller.enqueue(new Uint8Array([0xa9, 0x61, 0xf0, 0x9f, 0x9b, 0xa0]));
      },
      cancel,
    });
    const web = createWebFetcher({
      resolve: publicResolution,
      fetchPinned: () => Promise.resolve(plain(body)),
      config: { max_bytes: 4 },
    });
    await expect(web.fetchText(URL)).resolves.toMatchObject({
      text: "éa",
      truncated: true,
      content_hash: "805c58e80d5a6f66d9bed65cfb771031235943ef48fbe5c18b823df952da92c4",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not mark a body at the byte limit as truncated", async () => {
    const web = createWebFetcher({
      resolve: publicResolution,
      fetchPinned: () => Promise.resolve(plain("éa")),
      config: { max_bytes: 3 },
    });
    await expect(web.fetchText(URL)).resolves.toMatchObject({ text: "éa", truncated: false });
  });

  it.each([
    [200, "application/pdf", "CONTENT_UNSUPPORTED"],
    [200, null, "CONTENT_UNSUPPORTED"],
    [302, null, "UPSTREAM_RESPONSE_INVALID"],
    [429, null, "UPSTREAM_RATE_LIMITED"],
    [503, null, "UPSTREAM_UNAVAILABLE"],
  ] as const)("classifies status %i and content type %s", async (status, contentType, code) => {
    const web = createWebFetcher({
      resolve: publicResolution,
      fetchPinned: () =>
        Promise.resolve(
          new Response(null, {
            status,
            ...(contentType === null ? {} : { headers: { "content-type": contentType } }),
          }),
        ),
    });
    await expect(web.fetchText(URL)).rejects.toMatchObject({ code });
  });

  it("does not make a late request when the DNS deadline has already elapsed", async () => {
    vi.useFakeTimers();
    try {
      const dns = Promise.withResolvers<readonly string[]>();
      const resolve = vi.fn<Resolve>(() => dns.promise);
      const fetchPinned = vi.fn<FetchPinned>(() => Promise.resolve(plain("unexpected")));
      const web = createWebFetcher({ resolve, fetchPinned, timeoutMs: 20 });
      await Promise.all([
        expect(web.fetchText(URL)).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" }),
        vi.advanceTimersByTimeAsync(20),
      ]);
      expect(resolve.mock.calls[0]?.[1].aborted).toBe(true);
      dns.resolve([PUBLIC]);
      await dns.promise;
      expect(fetchPinned).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the overall deadline to an injected resolver that can stop its work", async () => {
    vi.useFakeTimers();
    try {
      const stopped = vi.fn<() => void>();
      const resolve: Resolve = (_host, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              stopped();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      const fetchPinned = vi.fn<FetchPinned>(() => Promise.resolve(plain("unexpected")));
      const web = createWebFetcher({ resolve, fetchPinned, timeoutMs: 20 });
      const result = web.fetchText(URL);
      await vi.advanceTimersByTimeAsync(19);
      expect(stopped).not.toHaveBeenCalled();
      await Promise.all([
        expect(result).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" }),
        vi.advanceTimersByTimeAsync(1),
      ]);
      expect(stopped).toHaveBeenCalledOnce();
      expect(fetchPinned).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a stalled response body on the same deadline as the request", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn<() => void>();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const web = createWebFetcher({
        resolve: publicResolution,
        fetchPinned: () => Promise.resolve(plain(body)),
        timeoutMs: 15,
      });
      await Promise.all([
        expect(web.fetchText(URL)).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" }),
        vi.advanceTimersByTimeAsync(15),
      ]);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

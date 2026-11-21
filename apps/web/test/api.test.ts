import { describe, expect, it, vi } from "vitest";

import { createDeskApi } from "../src/api.ts";

describe("Desk browser client", () => {
  it("uses the literal cursor on the next same-origin read and rejects malformed item links", async () => {
    const send = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(async (path) => {
      const url = new URL(path, "https://desk.example.test");
      if (url.searchParams.get("before") === "10.signal_b") {
        return Response.json({
          items: [
            {
              id: "signal_a",
              kind: "hn",
              url: "javascript:alert(1)",
              title: "Release",
              state: "feed_only",
              tier: null,
              first_seen_at: 10,
            },
          ],
          next: null,
        });
      }
      return Response.json({ items: [], next: "10.signal_b" });
    });
    const api = createDeskApi(send);
    const first = await api.feed(null);
    expect(first).toEqual({ ok: true, value: { items: [], next: "10.signal_b" } });
    if (!first.ok) throw new Error(first.message);
    expect(await api.feed(first.value.next)).toEqual({
      ok: false,
      message: "The desk returned an unexpected response. Reload to try again.",
    });
    expect(send).toHaveBeenLastCalledWith("/api/feed?limit=20&before=10.signal_b", {
      credentials: "same-origin",
      redirect: "manual",
    });
  });

  it("treats an expired session and a stale config differently without echoing response text", async () => {
    const denied = createDeskApi(async () =>
      Response.json(
        { error: { code: "UNAUTHENTICATED", detail: "private info" } },
        { status: 401 },
      ),
    );
    expect(await denied.session()).toEqual({
      ok: false,
      message: "Sign in through Cloudflare Access and reload.",
    });
    const conflict = createDeskApi(async () =>
      Response.json({ error: { code: "STATE_CONFLICT", detail: "private info" } }, { status: 409 }),
    );
    expect(await conflict.saveDestination("desk_slack", { enabled: false })).toEqual({
      ok: false,
      message: "Nothing was changed. Reload the controls before trying again.",
    });
  });

  it("does not mistake an Access sign-in document for a successful API response", async () => {
    const api = createDeskApi(
      async () =>
        new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }),
    );
    expect(await api.session()).toMatchObject({ ok: false });
  });
});

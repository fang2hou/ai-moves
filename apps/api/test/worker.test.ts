import { createD1Storage } from "@ai-moves/storage/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bundleWorker, startDesk } from "./emulator.ts";
import {
  fixtureConfig,
  operator,
  rawModelFixture,
  seedDesk,
  secretReferenceFixture,
  testAccess,
} from "./fixtures.ts";

let script: string;
let access: Awaited<ReturnType<typeof testAccess>>;
let desk: Awaited<ReturnType<typeof startDesk>>;
let assertion: string;
const base = "http://desk.local";

beforeAll(async () => {
  [script, access] = await Promise.all([bundleWorker(), testAccess()]);
  assertion = await access.sign();
}, 15_000);

beforeEach(async ({ onTestFinished }) => {
  desk = await startDesk(script, access.bindings);
  const { worker } = desk;
  onTestFinished(() => worker.dispose());
});

function read(path: string, token = assertion): ReturnType<typeof desk.worker.dispatchFetch> {
  return desk.worker.dispatchFetch(`${base}${path}`, {
    headers: token ? { "Cf-Access-Jwt-Assertion": token } : {},
  });
}

function mutate(
  path: string,
  method: "PUT" | "PATCH",
  body: unknown,
  token = assertion,
  origin = base,
): ReturnType<typeof desk.worker.dispatchFetch> {
  return desk.worker.dispatchFetch(`${base}${path}`, {
    method,
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
}

describe("Worker authentication", () => {
  it("only exposes readiness to unsigned requests, with no identity fallback", async () => {
    const readiness = await read("/healthz", "");
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).toEqual({ status: "ok" });
    for (const path of [
      "/",
      "/assets/main.js",
      "/api/feed",
      "/api/items/signal_z",
      "/api/alerts/alert_orbit",
      "/api/admin/destinations",
    ]) {
      const response = await read(path, "");
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    const cookieOnly = await desk.worker.dispatchFetch(`${base}/api/feed`, {
      headers: {
        Cookie: `CF_Authorization=${assertion}`,
        "Cf-Access-Authenticated-User-Email": "operator@example.test",
      },
    });
    expect(cookieOnly.status).toBe(401);
  });

  it("rejects wrong signatures, kid, audience, issuer, token kind and validity interval", async () => {
    const invalid = await Promise.all([
      access.sign({}, { wrongKey: true }),
      access.sign({}, { kid: "unknown" }),
      access.sign({ aud: ["other-app"] }),
      access.sign({ iss: "https://other.cloudflareaccess.com" }),
      access.sign({ type: "org" }),
      access.sign({ sub: "" }),
      access.sign({ exp: 1 }),
      access.sign({ nbf: 4_102_444_700 }),
    ]);
    for (const token of invalid) {
      const response = await read("/api/feed", token);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED" } });
    }
  });

  it("does not accept a correctly signed token when the application audience is unset", async () => {
    const { ACCESS_AUDIENCE: _missing, ...bindings } = access.bindings;
    const unconfigured = await startDesk(script, bindings);
    try {
      const response = await unconfigured.worker.dispatchFetch(`${base}/api/feed`, {
        headers: { "Cf-Access-Jwt-Assertion": assertion },
      });
      expect(response.status).toBe(401);
    } finally {
      await unconfigured.worker.dispose();
    }
  });
});

describe("Protected feed", () => {
  beforeEach(() => seedDesk(desk.database));

  it("pages ties exclusively and does not expose unreviewed items", async () => {
    const page = await read("/api/feed?limit=1");
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({
      items: [
        {
          id: "signal_z",
          kind: "hn",
          url: "https://example.test/orbit",
          title: "Orbit CLI adds isolated tool sessions",
          state: "alerted",
          tier: null,
          first_seen_at: 1_795_000_000_000,
        },
      ],
      next: "1795000000000.signal_z",
    });
    expect(await (await read("/api/feed?before=1795000000000.signal_z")).json()).toMatchObject({
      items: [{ id: "signal_a" }],
      next: null,
    });
    expect((await read("/api/items/signal_hidden")).status).toBe(404);
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=2&limit=3",
      "before=bad",
      "before=9999999999999999.a",
    ]) {
      expect((await read(`/api/feed?${query}`)).status).toBe(400);
    }
  });

  it("returns item-scoped history and only safe alert and delivery projections", async () => {
    const response = await read("/api/items/signal_z");
    expect(await response.json()).toMatchObject({
      item: { id: "signal_z" },
      alerts: [{ id: "alert_orbit" }],
    });
    expect(await (await read("/api/items/signal_a")).json()).toMatchObject({ alerts: [] });
    expect(await (await read("/api/alerts?limit=1")).json()).toMatchObject({
      alerts: [{ id: "alert_orbit" }],
      next: "1795000000000.alert_orbit",
    });
    const alertResponse = await read("/api/alerts/alert_orbit");
    const text = await alertResponse.text();
    expect(alertResponse.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      document: {
        summary: "Orbit CLI can keep tools in separate sessions without changing a shared shell.",
      },
      deliveries: [{ destination_id: "desk_slack", state: "sent" }],
    });
    for (const privateField of [
      rawModelFixture,
      "output_json",
      "analysis_private",
      "private-model-blob",
      "internal reason fixture",
      "private-provider-message",
      "secret_ref",
      secretReferenceFixture,
    ]) {
      expect(text).not.toContain(privateField);
    }
    expect(await (await read("/api/alerts/alert_orbit?lang=ja")).json()).toMatchObject({
      document: null,
    });
  });
});

describe("Audited administration", () => {
  describe("Destination policy", () => {
    beforeEach(() => seedDesk(desk.database));

    it("rejects non-admin, cross-origin and malformed writes without audit effects", async () => {
      const reader = await access.sign({ sub: "read-only-subject", admin: true });
      expect((await read("/api/feed", reader)).status).toBe(200);
      expect(await (await read("/api/session", reader)).json()).toEqual({ admin: false });
      expect((await read("/api/admin/destinations", reader)).status).toBe(403);
      const path = "/api/admin/destinations/desk_slack";
      expect((await mutate(path, "PATCH", { enabled: false }, reader)).status).toBe(403);
      expect(
        (
          await mutate(
            path,
            "PATCH",
            { enabled: false },
            assertion,
            "https://elsewhere.example.test",
          )
        ).status,
      ).toBe(403);
      expect((await mutate(path, "PATCH", { secret_ref: "TEST_OTHER_REFERENCE" })).status).toBe(
        400,
      );
      const oversized = await mutate(path, "PATCH", {
        enabled: false,
        padding: "a".repeat(70_000),
      });
      expect(oversized.status).toBe(413);
      const repos = createD1Storage(desk.database);
      expect(await repos.destinations.get("desk_slack")).toMatchObject({
        enabled: true,
        secret_ref: secretReferenceFixture,
      });
      expect(await repos.audit.listRecent(10)).toEqual([]);
    });

    it("edits policy without returning secret references and records the verified actor", async () => {
      const listing = await read("/api/admin/destinations");
      const body = await listing.text();
      expect(listing.status).toBe(200);
      expect(JSON.parse(body)).toMatchObject({
        destinations: [{ id: "desk_slack", daily_budget: 8 }],
      });
      expect(body).not.toContain("secret_ref");
      expect(body).not.toContain(secretReferenceFixture);
      expect(
        (await mutate("/api/admin/destinations/missing", "PATCH", { enabled: false })).status,
      ).toBe(409);
      expect(
        (
          await mutate("/api/admin/destinations/desk_slack", "PATCH", {
            enabled: false,
            daily_budget: 3,
          })
        ).status,
      ).toBe(204);
      const repos = createD1Storage(desk.database);
      expect(await repos.destinations.get("desk_slack")).toMatchObject({
        enabled: false,
        daily_budget: 3,
        secret_ref: secretReferenceFixture,
      });
      expect(await repos.audit.listRecent(10)).toMatchObject([
        {
          action: "destination.patch",
          actor: operator,
          target: "destination:desk_slack",
          detail_json: { enabled: false, daily_budget: 3 },
        },
      ]);
    });
  });

  it("publishes exactly one concurrent change from the same config version and audits the winner", async () => {
    const path = "/api/admin/config";
    expect(await (await read(path)).json()).toEqual({ current: null });
    const invalid = await mutate(path, "PUT", {
      expectedVersion: 0,
      config: { ...fixtureConfig, private_value: "invalid" },
    });
    expect(invalid.status).toBe(400);
    const updates = await Promise.all(
      [true, false].map((paused) =>
        mutate(path, "PUT", {
          expectedVersion: 0,
          config: { ...fixtureConfig, delivery: { ...fixtureConfig.delivery, paused } },
        }),
      ),
    );
    expect(updates.map((response) => response.status)).toEqual(expect.arrayContaining([200, 409]));
    const winner = updates.find((response) => response.status === 200);
    expect(await (await read(path)).json()).toEqual(await winner?.json());
    const repos = createD1Storage(desk.database);
    expect(await repos.config.getCurrent()).toMatchObject({ version: 1, created_by: operator });
    expect(await repos.audit.listRecent(10)).toMatchObject([
      {
        action: "config.publish",
        actor: operator,
        target: "config:1",
        detail_json: { previous: 0 },
      },
    ]);
  });
});

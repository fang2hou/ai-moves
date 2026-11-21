import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { redactText } from "@ai-moves/kernel/redact";
import { describe, expect, it } from "vitest";

import { fixturePath, RecordedExchangeSchema } from "../src/fixtures/exchange.ts";
import { FIXTURE_ROOT, listFixturePaths, loadFixture } from "../src/node/fixtures.ts";

const paths = listFixturePaths();

describe("fixture convention", () => {
  it("documents itself", () => {
    expect(existsSync(join(FIXTURE_ROOT, "README.md"))).toBe(true);
  });

  it("ships the format example", () => {
    expect(paths).toContain("_example/ok.json");
  });

  it.each(paths)("%s follows the schema and sits at the path its content names", (path) => {
    const parsed: unknown = JSON.parse(readFileSync(join(FIXTURE_ROOT, path), "utf8"));
    const exchange = RecordedExchangeSchema.parse(parsed);
    expect(fixturePath(exchange.upstream, exchange.scenario)).toBe(path);
    expect(exchange.origin === "recorded").toBe(exchange.recorded_on !== null);
    expect(loadFixture(exchange.upstream, exchange.scenario)).toEqual(exchange);
  });

  it.each(paths)("%s contains nothing the log redactor would treat as a secret", (path) => {
    const text = readFileSync(join(FIXTURE_ROOT, path), "utf8");
    expect(redactText(text)).toBe(text);
  });

  it("rejects a fixture with an unknown field or a non-https url", () => {
    const example = loadFixture("_example", "ok");
    expect(RecordedExchangeSchema.safeParse({ ...example, note: "x" }).success).toBe(false);
    expect(
      RecordedExchangeSchema.safeParse({
        ...example,
        request: { method: "GET", url: "http://upstream.example/" },
      }).success,
    ).toBe(false);
  });

  it("fails with a classified error when a fixture is missing", () => {
    expect(() => loadFixture("_example", "does-not-exist")).toThrow(
      "NOT_FOUND: fixture _example/does-not-exist.json",
    );
  });

  it("rejects a scenario that could traverse outside the fixture root", () => {
    expect(() => loadFixture("_example", "../../secret")).toThrow("Invalid string");
  });
});

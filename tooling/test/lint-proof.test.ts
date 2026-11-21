import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { LINT_PROOF_FIXTURE_ROOT } from "../src/boundaries.ts";
import { REPO_ROOT } from "../src/workspace.ts";

interface Diagnostic {
  readonly file: string;
  readonly code: string;
  readonly text: string;
}

interface LintRun {
  readonly status: number | null;
  readonly diagnostics: readonly Diagnostic[];
}

interface Violation {
  readonly file: string;
  readonly code: string;
  readonly explains: string;
}

const FIXTURE_PACKAGES = `${LINT_PROOF_FIXTURE_ROOT}/packages`;

const BOUNDARY_RULES = [
  "eslint(no-restricted-imports)",
  "eslint(no-restricted-globals)",
  "eslint(no-restricted-properties)",
  "eslint(no-console)",
  "node(no-process-env)",
  "import(no-nodejs-modules)",
];

const PLATFORM = "Platform modules are only allowed in adapter packages and apps";
const PROVIDER_SDK = "Provider SDKs are banned";
const DIRECTION = "breaks the dependency direction";
const NETWORK = "Raw network access is only allowed in sources, llm, and the delivery notifiers";

const VIOLATIONS: readonly Violation[] = [
  {
    file: "ingestion/src/import-cloudflare.ts",
    code: "eslint(no-restricted-imports)",
    explains: PLATFORM,
  },
  {
    file: "ingestion/src/import-cloudflare-types.ts",
    code: "eslint(no-restricted-imports)",
    explains: PLATFORM,
  },
  {
    file: "sources/src/import-cloudflare.ts",
    code: "eslint(no-restricted-imports)",
    explains: PLATFORM,
  },
  {
    file: "testing/src/import-emulator.ts",
    code: "eslint(no-restricted-imports)",
    explains: PLATFORM,
  },
  {
    file: "ingestion/src/import-provider-sdk.ts",
    code: "eslint(no-restricted-imports)",
    explains: PROVIDER_SDK,
  },
  { file: "ingestion/src/bare-fetch.ts", code: "eslint(no-restricted-globals)", explains: NETWORK },
  {
    file: "ingestion/src/global-this-fetch.ts",
    code: "eslint(no-restricted-globals)",
    explains: NETWORK,
  },
  {
    file: "delivery/src/render/bare-fetch.ts",
    code: "eslint(no-restricted-globals)",
    explains: NETWORK,
  },
  {
    file: "ingestion/src/import-adapter.ts",
    code: "eslint(no-restricted-imports)",
    explains: DIRECTION,
  },
  {
    file: "ingestion/src/import-sibling-component.ts",
    code: "eslint(no-restricted-imports)",
    explains: DIRECTION,
  },
  {
    file: "llm/src/import-adapter.ts",
    code: "eslint(no-restricted-imports)",
    explains: DIRECTION,
  },
  {
    file: "core/src/import-kernel.ts",
    code: "eslint(no-restricted-imports)",
    explains: DIRECTION,
  },
  {
    file: "contracts/src/import-kernel.ts",
    code: "eslint(no-restricted-imports)",
    explains: DIRECTION,
  },
  {
    file: "unclassified/src/import-contracts.ts",
    code: "eslint(no-restricted-imports)",
    explains: DIRECTION,
  },
  {
    file: "ingestion/src/import-deep-path.ts",
    code: "eslint(no-restricted-imports)",
    explains: DIRECTION,
  },
  {
    file: "ingestion/src/throw-native-error.ts",
    code: "eslint(no-restricted-globals)",
    explains: "Throw AppError",
  },
  { file: "ingestion/src/console-log.ts", code: "eslint(no-console)", explains: "console" },
  { file: "ingestion/src/process-env.ts", code: "node(no-process-env)", explains: "process.env" },
  {
    file: "ingestion/src/wall-clock.ts",
    code: "eslint(no-restricted-properties)",
    explains: "injected Clock port",
  },
  {
    file: "ingestion/src/explicit-any.ts",
    code: "typescript(no-explicit-any)",
    explains: "any",
  },
  {
    file: "ingestion/src/non-null-assertion.ts",
    code: "typescript(no-non-null-assertion)",
    explains: "non-null assertion",
  },
  {
    file: "ingestion/src/floating-promise.ts",
    code: "typescript(no-floating-promises)",
    explains: "Promises must be awaited",
  },
];

const ALLOWED: readonly string[] = [
  "ingestion/src/allowed.ts",
  "ingestion/test/allowed.test.ts",
  "delivery/src/notifiers/fetch-allowed.ts",
  "sources/src/fetch-allowed.ts",
  "storage/src/platform-allowed.ts",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function lint(paths: readonly string[]): LintRun {
  const result = spawnSync(
    join(REPO_ROOT, "node_modules/.bin/oxlint"),
    ["-c", ".oxlintrc.json", "-f", "json", ...paths],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const parsed: unknown = JSON.parse(result.stdout);
  const raw = isRecord(parsed) && Array.isArray(parsed["diagnostics"]) ? parsed["diagnostics"] : [];
  const diagnostics = raw.filter(isRecord).map((entry) => ({
    file: relative(FIXTURE_PACKAGES, text(entry["filename"])),
    code: text(entry["code"]),
    text: `${text(entry["message"])} ${text(entry["help"])}`,
  }));
  return { status: result.status, diagnostics };
}

function listFixtures(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? listFixtures(path) : [relative(FIXTURE_PACKAGES, path)];
  });
}

describe("lint negative proof", () => {
  const run = lint([FIXTURE_PACKAGES]);

  it("exits non-zero when the fixtures are linted with the repository config", () => {
    expect(run.status).toBe(1);
  });

  it("has an expectation for every fixture file", () => {
    const expected = [...VIOLATIONS.map((violation) => violation.file), ...ALLOWED];
    expect(listFixtures(FIXTURE_PACKAGES).toSorted()).toEqual(expected.toSorted());
  });

  it.each(VIOLATIONS)("rejects $file with $code", (violation) => {
    const matches = run.diagnostics.filter(
      (diagnostic) => diagnostic.file === violation.file && diagnostic.code === violation.code,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.map((diagnostic) => diagnostic.text).join("\n")).toContain(violation.explains);
  });

  it.each(VIOLATIONS)("fails the lint command for $file on its own", (violation) => {
    expect(lint([`${FIXTURE_PACKAGES}/${violation.file}`]).status).toBe(1);
  });

  it.each(ALLOWED)("raises no boundary diagnostic for %s", (file) => {
    const boundaryCodes = run.diagnostics
      .filter((diagnostic) => diagnostic.file === file)
      .map((diagnostic) => diagnostic.code)
      .filter((code) => BOUNDARY_RULES.includes(code));
    expect(boundaryCodes).toEqual([]);
  });
});

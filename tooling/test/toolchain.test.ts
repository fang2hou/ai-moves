import { describe, expect, it } from "vitest";

import { readManifest, readText } from "../src/workspace.ts";

function miseToolVersion(tool: string): string {
  const match = new RegExp(`^${tool}\\s*=\\s*"([^"]+)"`, "m").exec(readText("mise.toml"));
  if (match?.[1] === undefined) {
    throw new Error(`mise.toml does not pin ${tool}`);
  }
  return match[1];
}

const root = readManifest(".");

describe("toolchain pins", () => {
  it("pins the same pnpm version in mise.toml and packageManager", () => {
    expect(root.packageManager).toBe(`pnpm@${miseToolVersion("pnpm")}`);
  });

  it("uses the mise Node.js version as the lower bound of engines.node", () => {
    expect(root.engines["node"]).toMatch(new RegExp(`^>=${miseToolVersion("node")} <\\d+$`));
  });

  it("enforces engines at install time", () => {
    expect(readText("pnpm-workspace.yaml")).toMatch(/^engineStrict: true$/m);
  });
});

describe("CI workflow", () => {
  const workflow = readText(".github/workflows/ci.yml");
  const runCommands = [...workflow.matchAll(/^\s+run: (.+)$/gm)].map((match) => match[1]);

  it.each(["mise run check", "mise run test"])("runs the shared `%s` task", (command) => {
    expect(runCommands).toContain(command);
  });

  it("installs from the frozen lockfile", () => {
    expect(runCommands).toContain("pnpm install --frozen-lockfile");
  });
});

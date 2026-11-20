import { describe, expect, it } from "vitest";

import {
  allowedWorkspaceDependencies,
  findBoundary,
  PACKAGE_BOUNDARIES,
  TOOLING_PACKAGE,
  WORKSPACE_SCOPE,
} from "../src/boundaries.ts";
import { buildOxlintConfig } from "../src/oxlint-config.ts";
import { listWorkspacePackages, readJson, tsconfigReferences } from "../src/workspace.ts";

const workspacePackages = listWorkspacePackages();

function workspaceNames(record: Readonly<Record<string, string>>): string[] {
  return Object.keys(record).filter((name) => name.startsWith(`${WORKSPACE_SCOPE}/`));
}

describe("lint configuration", () => {
  it("keeps the committed .oxlintrc.json in sync with tooling/src/oxlint-config.ts", () => {
    expect(readJson(".oxlintrc.json")).toEqual(JSON.parse(JSON.stringify(buildOxlintConfig())));
  });
});

describe("dependency direction", () => {
  it("forms an acyclic graph in which every import target is a known package", () => {
    const order = new Map(PACKAGE_BOUNDARIES.map((entry, index) => [entry.name, index]));
    for (const entry of PACKAGE_BOUNDARIES) {
      for (const target of entry.imports) {
        const targetIndex = order.get(target);
        expect(targetIndex, `${entry.name} -> ${target}`).toBeDefined();
        expect(targetIndex, `${entry.name} -> ${target}`).toBeLessThan(order.get(entry.name) ?? -1);
      }
    }
  });

  it.each(workspacePackages)(
    "$dir is classified and declares only allowed workspace deps",
    (pkg) => {
      const entry = findBoundary(pkg.manifest.name);
      expect(entry, `${pkg.dir} is missing from tooling/src/boundaries.ts`).toBeDefined();
      if (entry === undefined) {
        return;
      }
      expect(entry.dir).toBe(pkg.dir);

      const runtime = [
        ...workspaceNames(pkg.manifest.dependencies),
        ...workspaceNames(pkg.manifest.peerDependencies),
        ...workspaceNames(pkg.manifest.optionalDependencies),
      ];
      expect(runtime.filter((name) => !entry.imports.includes(name))).toEqual([]);

      const allowedDev = [...allowedWorkspaceDependencies(entry), TOOLING_PACKAGE];
      const dev = workspaceNames(pkg.manifest.devDependencies);
      expect(dev.filter((name) => !allowedDev.includes(name))).toEqual([]);
    },
  );

  it.each(workspacePackages)("$dir can be linted, typechecked, and tested on its own", (pkg) => {
    expect(Object.keys(pkg.manifest.scripts)).toEqual(
      expect.arrayContaining(["lint", "test", "typecheck"]),
    );
  });

  it("references every workspace package from the root tsconfig", () => {
    const references = tsconfigReferences("tsconfig.json").map((path) => path.replace(/^\.\//, ""));
    expect(references).toEqual(
      expect.arrayContaining(["tooling", ...workspacePackages.map((pkg) => pkg.dir)]),
    );
  });
});

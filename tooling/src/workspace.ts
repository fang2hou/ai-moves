import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface PackageManifest {
  readonly name: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly packageManager: string | undefined;
  readonly engines: Readonly<Record<string, string>>;
}

export interface WorkspacePackage {
  readonly dir: string;
  readonly manifest: PackageManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.fromEntries(entries);
}

export function readText(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

export function readJson(relativePath: string): unknown {
  return JSON.parse(readText(relativePath));
}

export function readManifest(dir: string): PackageManifest {
  const raw = readJson(join(dir, "package.json"));
  if (!isRecord(raw) || typeof raw["name"] !== "string") {
    throw new Error(`${dir}/package.json has no name`);
  }
  return {
    name: raw["name"],
    scripts: stringRecord(raw["scripts"]),
    dependencies: stringRecord(raw["dependencies"]),
    devDependencies: stringRecord(raw["devDependencies"]),
    peerDependencies: stringRecord(raw["peerDependencies"]),
    optionalDependencies: stringRecord(raw["optionalDependencies"]),
    packageManager: typeof raw["packageManager"] === "string" ? raw["packageManager"] : undefined,
    engines: stringRecord(raw["engines"]),
  };
}

export function listWorkspacePackages(): WorkspacePackage[] {
  const found: WorkspacePackage[] = [];
  for (const group of ["apps", "packages"]) {
    const groupPath = join(REPO_ROOT, group);
    if (!existsSync(groupPath)) {
      continue;
    }
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      const dir = `${group}/${entry.name}`;
      if (entry.isDirectory() && existsSync(join(REPO_ROOT, dir, "package.json"))) {
        found.push({ dir, manifest: readManifest(dir) });
      }
    }
  }
  return found.toSorted((left, right) => left.dir.localeCompare(right.dir));
}

export function tsconfigReferences(relativePath: string): string[] {
  const raw = readJson(relativePath);
  if (!isRecord(raw) || !Array.isArray(raw["references"])) {
    return [];
  }
  return raw["references"].flatMap((reference: unknown) =>
    isRecord(reference) && typeof reference["path"] === "string" ? [reference["path"]] : [],
  );
}

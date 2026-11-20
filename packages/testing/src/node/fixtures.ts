import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { AppError } from "@ai-moves/kernel/errors/app-error";
import { parseJsonBoundary } from "@ai-moves/kernel/boundary";

import {
  fixturePath,
  type FixtureUpstream,
  type RecordedExchange,
  RecordedExchangeSchema,
} from "../fixtures/exchange.ts";

export const FIXTURE_ROOT = fileURLToPath(new URL("../../fixtures/", import.meta.url));

function fixtureFilePath(relativePath: string): string {
  const root = resolve(FIXTURE_ROOT);
  const absolutePath = resolve(root, relativePath);
  const containedPath = relative(root, absolutePath);
  if (containedPath === ".." || containedPath.startsWith(`..${sep}`) || isAbsolute(containedPath)) {
    throw new AppError("INPUT_INVALID", {
      message: `INPUT_INVALID: fixture path escapes fixture root: ${relativePath}`,
      context: { fixture: relativePath },
    });
  }
  return absolutePath;
}

export function loadFixture(upstream: FixtureUpstream, scenario: string): RecordedExchange {
  const relativePath = fixturePath(upstream, scenario);
  const absolutePath = fixtureFilePath(relativePath);
  if (!existsSync(absolutePath)) {
    throw new AppError("NOT_FOUND", {
      message: `NOT_FOUND: fixture ${relativePath}`,
      context: { fixture: relativePath },
    });
  }
  return parseJsonBoundary(
    RecordedExchangeSchema,
    readFileSync(absolutePath, "utf8"),
    "INPUT_INVALID",
    {
      fixture: relativePath,
    },
  );
}

export function listFixturePaths(): string[] {
  return readdirSync(FIXTURE_ROOT, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".json"))
    .map((path) => path.split("\\").join("/"))
    .toSorted();
}

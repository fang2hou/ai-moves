export const WORKSPACE_SCOPE = "@ai-moves";

export type Capability =
  | "platform"
  | "raw-fetch"
  | "node-builtins"
  | "native-error"
  | "console"
  | "nondeterminism";

export interface Exemption {
  readonly files: readonly string[];
  readonly capabilities: readonly Capability[];
}

export interface PackageBoundary {
  readonly dir: string;
  readonly name: string;
  readonly imports: readonly string[];
  readonly testImports: readonly string[];
  readonly capabilities: readonly Capability[];
  readonly testCapabilities: readonly Capability[];
  readonly exemptions: readonly Exemption[];
}

interface BoundaryInput {
  readonly dir: string;
  readonly imports?: readonly string[];
  readonly testImports?: readonly string[];
  readonly capabilities?: readonly Capability[];
  readonly testCapabilities?: readonly Capability[];
  readonly exemptions?: readonly Exemption[];
}

const scoped = (short: string): string => `${WORKSPACE_SCOPE}/${short}`;

function boundary(input: BoundaryInput): PackageBoundary {
  const short = input.dir.slice(input.dir.lastIndexOf("/") + 1);
  return {
    dir: input.dir,
    name: scoped(short),
    imports: (input.imports ?? []).map(scoped),
    testImports: (input.testImports ?? ["testing"]).map(scoped),
    capabilities: input.capabilities ?? [],
    testCapabilities: input.testCapabilities ?? [],
    exemptions: input.exemptions ?? [],
  };
}

// Mirrors docs/architecture-v1.md section 3.2. `contracts` and `kernel` sit below `testing`,
// so their tests cannot use it without creating a cycle.
export const PACKAGE_BOUNDARIES: readonly PackageBoundary[] = [
  boundary({ dir: "packages/contracts", testImports: [] }),
  boundary({
    dir: "packages/kernel",
    imports: ["contracts"],
    testImports: [],
    exemptions: [
      { files: ["src/errors/**"], capabilities: ["native-error"] },
      { files: ["src/telemetry/console.ts"], capabilities: ["console"] },
      { files: ["src/clock.ts", "src/id.ts"], capabilities: ["nondeterminism"] },
    ],
  }),
  boundary({ dir: "packages/core", imports: ["contracts"] }),
  boundary({ dir: "packages/prompts", imports: ["contracts"] }),
  boundary({
    dir: "packages/storage",
    imports: ["contracts", "kernel"],
    capabilities: ["platform"],
  }),
  boundary({ dir: "packages/llm", imports: ["contracts", "kernel"], capabilities: ["raw-fetch"] }),
  boundary({
    dir: "packages/sources",
    imports: ["contracts", "kernel"],
    capabilities: ["raw-fetch"],
  }),
  boundary({
    dir: "packages/runtime-cloudflare",
    imports: ["contracts", "kernel"],
    capabilities: ["platform"],
  }),
  boundary({ dir: "packages/ingestion", imports: ["contracts", "kernel", "core"] }),
  boundary({ dir: "packages/analysis", imports: ["contracts", "kernel", "core", "prompts"] }),
  boundary({
    dir: "packages/delivery",
    imports: ["contracts", "kernel", "core"],
    exemptions: [{ files: ["src/notifiers/**"], capabilities: ["raw-fetch"] }],
  }),
  boundary({
    dir: "packages/testing",
    imports: ["contracts", "kernel"],
    testImports: [],
    testCapabilities: ["platform"],
    exemptions: [
      { files: ["src/node/**"], capabilities: ["node-builtins"] },
      { files: ["src/upstream/**"], capabilities: ["native-error"] },
    ],
  }),
  boundary({
    dir: "apps/pipeline",
    imports: [
      "contracts",
      "kernel",
      "ingestion",
      "analysis",
      "storage",
      "llm",
      "sources",
      "runtime-cloudflare",
    ],
    testImports: ["testing", "api", "delivery"],
    capabilities: ["platform"],
  }),
  boundary({
    dir: "apps/api",
    imports: ["contracts", "kernel", "core", "storage", "runtime-cloudflare"],
    capabilities: ["platform"],
  }),
  boundary({ dir: "apps/web", imports: ["contracts"] }),
];

export const TOOLING_DIR = "tooling";
export const TOOLING_PACKAGE = scoped("tooling");

export const LINT_PROOF_FIXTURE_ROOT = "tooling/lint-proof/fixtures";

export function findBoundary(name: string): PackageBoundary | undefined {
  return PACKAGE_BOUNDARIES.find((entry) => entry.name === name);
}

export function allowedWorkspaceDependencies(entry: PackageBoundary): readonly string[] {
  return [...new Set([...entry.imports, ...entry.testImports])];
}

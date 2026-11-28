export const WORKSPACE_SCOPE = "@ai-news-tracker";

export type Capability =
  | "platform"
  | "raw-fetch"
  | "node-builtins"
  | "native-error"
  | "console"
  | "nondeterminism";

// A later exemption replaces an earlier one wherever both match, so name each file in one
// exemption with everything it needs.
export interface Exemption {
  readonly files: readonly string[];
  readonly capabilities: readonly Capability[];
}

export interface PackageBoundary {
  readonly dir: string;
  readonly name: string;
  readonly imports: readonly string[];
  readonly capabilities: readonly Capability[];
  readonly exemptions: readonly Exemption[];
}

interface BoundaryInput {
  readonly dir: string;
  // The package's short name where the directory is not named after it.
  readonly name?: string;
  readonly imports?: readonly string[];
  readonly capabilities?: readonly Capability[];
  readonly exemptions?: readonly Exemption[];
}

const scoped = (short: string): string => `${WORKSPACE_SCOPE}/${short}`;

function boundary(input: BoundaryInput): PackageBoundary {
  const short = input.name ?? input.dir.slice(input.dir.lastIndexOf("/") + 1);
  return {
    dir: input.dir,
    name: scoped(short),
    imports: (input.imports ?? []).map(scoped),
    capabilities: input.capabilities ?? [],
    exemptions: input.exemptions ?? [],
  };
}

// Mirrors docs/architecture-v1.md section 3.2.
export const PACKAGE_BOUNDARIES: readonly PackageBoundary[] = [
  boundary({ dir: "packages/contracts" }),
  boundary({
    dir: "packages/kernel",
    imports: ["contracts"],
    exemptions: [
      { files: ["src/errors/**"], capabilities: ["native-error"] },
      { files: ["src/telemetry/console.ts"], capabilities: ["console"] },
      { files: ["src/clock.ts", "src/id.ts"], capabilities: ["nondeterminism"] },
    ],
  }),
  boundary({ dir: "packages/core", imports: ["contracts"] }),
  boundary({ dir: "packages/locales", imports: ["contracts"] }),
  boundary({ dir: "packages/prompts", imports: ["contracts", "locales"] }),
  boundary({ dir: "packages/storage", imports: ["contracts", "kernel"] }),
  boundary({
    dir: "packages/storage-d1",
    imports: ["contracts", "kernel", "storage"],
    capabilities: ["platform"],
  }),
  // DynamoDB is reached through an injected client, so the adapter needs no network capability.
  boundary({ dir: "packages/storage-dynamodb", imports: ["contracts", "kernel", "storage"] }),
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
  // AWS services are called over an injected fetch with request signing, never through an SDK.
  boundary({ dir: "packages/runtime-aws", imports: ["contracts", "kernel"] }),
  boundary({ dir: "packages/ingestion", imports: ["contracts", "kernel", "core"] }),
  boundary({
    dir: "packages/analysis",
    imports: ["contracts", "kernel", "core", "prompts", "locales"],
  }),
  boundary({
    dir: "packages/delivery",
    imports: ["contracts", "kernel", "core", "locales"],
    exemptions: [{ files: ["src/notifiers/**"], capabilities: ["raw-fetch"] }],
  }),
  boundary({
    dir: "apps/pipeline",
    imports: [
      "contracts",
      "kernel",
      "ingestion",
      "analysis",
      "delivery",
      "storage",
      "storage-d1",
      "storage-dynamodb",
      "llm",
      "sources",
      "runtime-aws",
      "runtime-cloudflare",
    ],
    capabilities: ["platform"],
    // A deployed Worker has no binding for outbound HTTP, so the composition root
    // builds one from the platform's fetch and injects it like any other port. On Lambda
    // the composition root resolves and pins connections with Node's own modules.
    exemptions: [
      { files: ["src/egress.ts"], capabilities: ["raw-fetch"] },
      { files: ["src/aws/egress.ts"], capabilities: ["raw-fetch", "node-builtins"] },
      { files: ["src/aws/lambda.ts"], capabilities: ["raw-fetch"] },
      { files: ["src/aws/handler.ts"], capabilities: ["node-builtins"] },
    ],
  }),
  boundary({
    dir: "apps/api",
    imports: [
      "contracts",
      "kernel",
      "core",
      "storage",
      "storage-d1",
      "storage-dynamodb",
      "runtime-aws",
      "runtime-cloudflare",
    ],
    capabilities: ["platform"],
    exemptions: [
      { files: ["src/lambda.ts"], capabilities: ["raw-fetch"] },
      { files: ["src/handler.ts"], capabilities: ["node-builtins"] },
    ],
  }),
  boundary({ dir: "apps/web", imports: ["contracts", "kernel", "locales"] }),
  boundary({
    dir: "tools/local",
    name: "local-demo",
    imports: [
      "contracts",
      "delivery",
      "kernel",
      "llm",
      "pipeline",
      "prompts",
      "runtime-aws",
      "storage-d1",
      "storage-dynamodb",
    ],
    capabilities: ["node-builtins", "native-error"],
    // Scripts on a developer machine: those that reach the network use the platform's fetch,
    // as the pipeline's egress module does, and those that print a result write to the console.
    exemptions: [
      { files: ["probe-model.ts", "probe-deep.ts"], capabilities: ["raw-fetch"] },
      { files: ["card-json.ts"], capabilities: ["console", "raw-fetch"] },
      { files: ["schema-sql.ts", "seed-sql.ts", "dynamodb-table.ts"], capabilities: ["console"] },
      { files: ["seed-dynamodb.ts"], capabilities: ["console", "raw-fetch"] },
      { files: ["run.ts"], capabilities: ["platform", "raw-fetch"] },
    ],
  }),
];

export const TOOLING_DIR = "tooling";

export function findBoundary(name: string): PackageBoundary | undefined {
  return PACKAGE_BOUNDARIES.find((entry) => entry.name === name);
}

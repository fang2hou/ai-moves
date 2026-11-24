import {
  type Capability,
  LINT_PROOF_FIXTURE_ROOT,
  PACKAGE_BOUNDARIES,
  type PackageBoundary,
  TOOLING_DIR,
  TOOLING_PACKAGE,
  WORKSPACE_SCOPE,
} from "./boundaries.ts";

type Severity = "error" | "off";
type RuleConfig = Severity | readonly [Severity, ...unknown[]];
type Rules = Record<string, RuleConfig>;

interface Override {
  readonly files: readonly string[];
  readonly rules: Rules;
}

export interface OxlintConfig {
  readonly $schema: string;
  readonly plugins: readonly string[];
  readonly categories: Record<string, Severity>;
  readonly options: Record<string, unknown>;
  readonly ignorePatterns: readonly string[];
  readonly rules: Rules;
  readonly overrides: readonly Override[];
}

const PLATFORM_PATTERNS = ["cloudflare:*", "@cloudflare/*", "wrangler", "miniflare"];

const PROVIDER_SDK_PATTERNS = [
  "openai",
  "@openai/*",
  "@anthropic-ai/*",
  "@openrouter/*",
  "ai",
  "@ai-sdk/*",
  "langchain",
  "@langchain/*",
  "@aws-sdk/*",
  "@google/genai",
  "@google/generative-ai",
  "@google-cloud/*",
  "@octokit/*",
  "octokit",
  "@slack/*",
  "discord.js",
  "@discordjs/*",
];

const NETWORK_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"];
const NATIVE_ERROR_GLOBALS = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "EvalError",
  "URIError",
];

const MESSAGES = {
  platform:
    "Platform modules are only allowed in adapter packages and apps (architecture 3.3). Depend on a port from @ai-moves/contracts.",
  providerSdk:
    "Provider SDKs are banned (architecture 10, supply chain). Call the provider over fetch inside its adapter package.",
  workspace:
    "This import breaks the dependency direction in architecture 3.2. Allowed workspace imports are listed in tooling/src/boundaries.ts.",
  deepImport: "Import workspace packages through their public entry points only.",
  network:
    "Raw network access is only allowed in sources, llm, and the delivery notifiers (architecture 3.3). Inject the client through a port.",
  nativeError:
    "Throw AppError from @ai-moves/kernel so every failure carries a code and kind (architecture 4.5).",
  process: "Read configuration through the @ai-moves/kernel config loader (architecture 14.1).",
  clock: "Use the injected Clock port so behaviour stays deterministic.",
  random: "Use the injected IdGen port so behaviour stays deterministic.",
} as const;

function workspacePattern(allowed: readonly string[]): Record<string, unknown> {
  return {
    group: [
      `${WORKSPACE_SCOPE}/**`,
      ...allowed.flatMap((name) => [`!${name}`, `!${name}/**`]),
      `${WORKSPACE_SCOPE}/*/src`,
      `${WORKSPACE_SCOPE}/*/src/**`,
    ],
    message: MESSAGES.workspace,
  };
}

function restrictedImports(
  allowed: readonly string[],
  capabilities: ReadonlySet<Capability>,
): RuleConfig {
  const patterns: Record<string, unknown>[] = [
    { group: PROVIDER_SDK_PATTERNS, message: MESSAGES.providerSdk },
    workspacePattern(allowed),
  ];
  if (!capabilities.has("platform")) {
    patterns.unshift({ group: PLATFORM_PATTERNS, message: MESSAGES.platform });
  }
  return ["error", { patterns }];
}

function restrictedGlobals(capabilities: ReadonlySet<Capability>): RuleConfig {
  const globals: Record<string, string>[] = [];
  if (!capabilities.has("raw-fetch")) {
    globals.push(...NETWORK_GLOBALS.map((name) => ({ name, message: MESSAGES.network })));
  }
  if (!capabilities.has("native-error")) {
    globals.push(...NATIVE_ERROR_GLOBALS.map((name) => ({ name, message: MESSAGES.nativeError })));
  }
  if (!capabilities.has("node-builtins")) {
    globals.push({ name: "process", message: MESSAGES.process });
  }
  if (globals.length === 0) {
    return "off";
  }
  return ["error", { globals, checkGlobalObject: true }];
}

function restrictedProperties(capabilities: ReadonlySet<Capability>): RuleConfig {
  if (capabilities.has("nondeterminism")) {
    return "off";
  }
  return [
    "error",
    { object: "Date", property: "now", message: MESSAGES.clock },
    { object: "performance", property: "now", message: MESSAGES.clock },
    { object: "Math", property: "random", message: MESSAGES.random },
    { object: "crypto", property: "randomUUID", message: MESSAGES.random },
    { object: "crypto", property: "getRandomValues", message: MESSAGES.random },
  ];
}

function boundaryRules(allowed: readonly string[], capabilities: ReadonlySet<Capability>): Rules {
  return {
    "no-restricted-imports": restrictedImports(allowed, capabilities),
    "no-restricted-globals": restrictedGlobals(capabilities),
    "no-restricted-properties": restrictedProperties(capabilities),
    "no-console": capabilities.has("console") ? "off" : "error",
    "import/no-nodejs-modules": capabilities.has("node-builtins") ? "off" : "error",
    "node/no-process-env": "error",
  };
}

const TEST_CAPABILITIES: readonly Capability[] = [
  "node-builtins",
  "native-error",
  "nondeterminism",
];

function scopedGlobs(dir: string, patterns: readonly string[]): string[] {
  return [dir, `${LINT_PROOF_FIXTURE_ROOT}/${dir}`].flatMap((root) =>
    patterns.map((pattern) => `${root}/${pattern}`),
  );
}

function packageOverrides(entry: PackageBoundary): Override[] {
  const base = new Set(entry.capabilities);
  const overrides: Override[] = [
    { files: scopedGlobs(entry.dir, ["**"]), rules: boundaryRules(entry.imports, base) },
  ];
  for (const exemption of entry.exemptions) {
    overrides.push({
      files: scopedGlobs(entry.dir, exemption.files),
      rules: boundaryRules(entry.imports, new Set([...base, ...exemption.capabilities])),
    });
  }
  overrides.push({
    files: scopedGlobs(entry.dir, ["test/**", "*.config.ts"]),
    rules: boundaryRules(
      [...entry.imports, ...entry.testImports, TOOLING_PACKAGE],
      new Set([...base, ...TEST_CAPABILITIES, ...entry.testCapabilities]),
    ),
  });
  return overrides;
}

const NO_CAPABILITIES: ReadonlySet<Capability> = new Set();

export function buildOxlintConfig(): OxlintConfig {
  return {
    $schema: "./node_modules/oxlint/configuration_schema.json",
    plugins: ["typescript", "unicorn", "oxc", "import", "node", "promise", "vitest"],
    categories: { correctness: "error", suspicious: "error" },
    options: { denyWarnings: true, reportUnusedDisableDirectives: "error", typeAware: true },
    ignorePatterns: ["**/dist/**"],
    rules: {
      eqeqeq: "error",
      "no-var": "error",
      "prefer-const": "error",
      "no-empty": "error",
      "no-throw-literal": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/consistent-type-imports": "error",
      "typescript/no-require-imports": "error",
      "typescript/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true },
      ],
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/await-thenable": "error",
      "typescript/only-throw-error": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "import/no-cycle": "error",
      "import/no-default-export": "error",
      "import/no-commonjs": "error",
      ...boundaryRules([], NO_CAPABILITIES),
    },
    overrides: [
      {
        files: [`${TOOLING_DIR}/**`],
        rules: boundaryRules([], new Set<Capability>(TEST_CAPABILITIES)),
      },
      ...PACKAGE_BOUNDARIES.flatMap(packageOverrides),
      {
        files: ["**/*.config.ts"],
        rules: { "import/no-default-export": "off" },
      },
      {
        // Contract suites hold assertions in case functions that `runPortContract` registers.
        files: ["packages/*/src/contract/**"],
        rules: {
          "vitest/no-standalone-expect": "off",
          "vitest/expect-expect": "off",
          "vitest/valid-title": "off",
        },
      },
    ],
  };
}

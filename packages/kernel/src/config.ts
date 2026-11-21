import {
  type AppConfig,
  AppConfigSchema,
  type RuntimeEnv,
  RuntimeEnvSchema,
} from "@ai-moves/contracts/config";

import { parseBoundary, parseJsonBoundary } from "./boundary.ts";

// The only way configuration enters the system. Deployment units pass their environment object
// here at startup; nothing else reads environment variables (architecture 14.1).

export function loadRuntimeEnv(env: unknown): RuntimeEnv {
  return parseBoundary(RuntimeEnvSchema, env, "CONFIG_INVALID", { source: "runtime_env" });
}

export function loadAppConfig(raw: unknown): AppConfig {
  return parseBoundary(AppConfigSchema, raw, "CONFIG_INVALID", { source: "app_config" });
}

export function loadAppConfigJson(text: string): AppConfig {
  return parseJsonBoundary(AppConfigSchema, text, "CONFIG_INVALID", { source: "app_config" });
}

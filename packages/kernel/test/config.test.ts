import { describe, expect, it } from "vitest";

import { loadAppConfig, loadAppConfigJson, loadRuntimeEnv } from "../src/config.ts";
import { isAppError } from "../src/errors/app-error.ts";

const models = {
  triage: { provider: "fake", model: "fake-small", max_output_tokens: 800 },
  deep: { provider: "fake", model: "fake-large", max_output_tokens: 4000 },
  translate: { provider: "fake", model: "fake-small", max_output_tokens: 2000 },
};

function capture(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("loadRuntimeEnv", () => {
  it("returns only the declared variables with defaults applied", () => {
    const env = { ENVIRONMENT: "local", OPENROUTER_API_KEY: "sk-test-not-a-real-key", DB: {} };
    expect(loadRuntimeEnv(env)).toEqual({ ENVIRONMENT: "local", LOG_LEVEL: "info" });
  });

  it("fails startup with CONFIG_INVALID and does not leak other variables", () => {
    const error = capture(() =>
      loadRuntimeEnv({ ENVIRONMENT: "staging", OPENROUTER_API_KEY: "sk-test-not-a-real-key" }),
    );
    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) {
      return;
    }
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.kind).toBe("validation");
    expect(error.context).toMatchObject({
      source: "runtime_env",
      issues: [{ path: "ENVIRONMENT" }],
    });
    expect(`${error.message} ${JSON.stringify(error.context)}`).not.toContain("sk-test");
  });

  it("rejects a missing environment object", () => {
    expect(isAppError(capture(() => loadRuntimeEnv(undefined)))).toBe(true);
  });
});

describe("loadAppConfig", () => {
  it("applies defaults", () => {
    const config = loadAppConfig({ models });
    expect(config.ai.enabled).toBe(true);
    expect(config.delivery.force_dry_run).toBe(true);
  });

  it("round-trips through JSON", () => {
    const config = loadAppConfig({ models, ai: { enabled: false } });
    expect(loadAppConfigJson(JSON.stringify(config))).toEqual(config);
  });

  it("rejects an unknown key with CONFIG_INVALID", () => {
    const error = capture(() => loadAppConfig({ models, ai: { enabeld: false } }));
    expect(isAppError(error) && error.code).toBe("CONFIG_INVALID");
    expect(isAppError(error) && error.context).toMatchObject({
      source: "app_config",
      issues: [{ path: "ai", issue: "unrecognized_keys" }],
    });
  });

  it("rejects malformed JSON with CONFIG_INVALID", () => {
    const error = capture(() => loadAppConfigJson("{"));
    expect(isAppError(error) && error.code).toBe("CONFIG_INVALID");
  });
});

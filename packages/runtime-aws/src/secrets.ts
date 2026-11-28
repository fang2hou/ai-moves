import type { Clock, SecretProvider } from "@ai-news-tracker/contracts/ports/runtime";
import { SecretRefSchema } from "@ai-news-tracker/contracts/primitives";
import { parseBoundary } from "@ai-news-tracker/kernel/boundary";
import { AppError } from "@ai-news-tracker/kernel/errors/app-error";

import type { AwsJsonClient } from "./json-client.ts";

export interface SsmSecretOptions {
  // Parameter path the reference is appended to, ending in "/" (for example "/my-app/env/").
  readonly prefix: string;
  readonly clock: Clock;
  // How long a value read from Parameter Store is reused within one runtime instance.
  readonly cacheMs: number;
}

// Reads SecureString parameters. A missing parameter is SECRET_MISSING, like an unbound Worker
// secret; anything else the service refuses is retryable, because a later attempt may succeed.
export function createSsmSecretProvider(
  ssm: AwsJsonClient,
  options: SsmSecretOptions,
): SecretProvider {
  if (!/^\/(?:[A-Za-z0-9_.-]+\/)*$/u.test(options.prefix)) {
    throw new AppError("CONFIG_INVALID", {
      message: "Parameter prefix must be a path ending in /",
    });
  }
  const cache = new Map<string, { readonly value: string; readonly expiresAt: number }>();
  return {
    async get(input) {
      const ref = parseBoundary(SecretRefSchema, input, "INPUT_INVALID");
      const now = options.clock.now();
      const cached = cache.get(ref);
      if (cached !== undefined && cached.expiresAt > now) return cached.value;
      const result = await ssm.call("GetParameter", {
        Name: `${options.prefix}${ref}`,
        WithDecryption: true,
      });
      if (!result.ok) {
        if (result.type === "ParameterNotFound") throw new AppError("SECRET_MISSING");
        throw new AppError("UPSTREAM_UNAVAILABLE", {
          message: "UPSTREAM_UNAVAILABLE: Parameter Store refused the read",
          context: { status: result.status, type: result.type },
        });
      }
      const parameter = result.body["Parameter"];
      const value: unknown =
        typeof parameter === "object" && parameter !== null
          ? Reflect.get(parameter, "Value")
          : undefined;
      if (typeof value !== "string" || value.length === 0) throw new AppError("SECRET_MISSING");
      cache.set(ref, { value, expiresAt: now + options.cacheMs });
      return value;
    },
  };
}

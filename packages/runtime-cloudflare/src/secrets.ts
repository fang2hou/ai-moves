import type { SecretProvider } from "@ai-news-tracker/contracts/ports/runtime";
import { SecretRefSchema } from "@ai-news-tracker/contracts/primitives";
import { parseBoundary } from "@ai-news-tracker/kernel/boundary";
import { AppError } from "@ai-news-tracker/kernel/errors/app-error";

export type CloudflareSecretBindings = object;

export function createCloudflareSecretProvider(bindings: CloudflareSecretBindings): SecretProvider {
  return {
    get: (input) => {
      const ref = parseBoundary(SecretRefSchema, input, "INPUT_INVALID");
      const value: unknown = Object.hasOwn(bindings, ref) ? Reflect.get(bindings, ref) : undefined;
      if (typeof value !== "string" || value.length === 0) {
        return Promise.reject(new AppError("SECRET_MISSING"));
      }
      return Promise.resolve(value);
    },
  };
}

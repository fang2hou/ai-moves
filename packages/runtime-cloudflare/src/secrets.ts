import type { SecretProvider } from "@ai-moves/contracts/ports/runtime";
import { SecretRefSchema } from "@ai-moves/contracts/primitives";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { AppError } from "@ai-moves/kernel/errors/app-error";

export type CloudflareSecretBindings = object;

export function createCloudflareSecretProvider(bindings: CloudflareSecretBindings): SecretProvider {
  return {
    get: (input) => {
      const ref = parseBoundary(SecretRefSchema, input, "INPUT_INVALID");
      const value: unknown = Reflect.get(bindings, ref);
      if (typeof value !== "string" || value.length === 0) {
        return Promise.reject(
          new AppError("SECRET_MISSING", {
            message: `SECRET_MISSING: Cloudflare secret binding ${ref} is not available`,
            context: { binding: ref },
          }),
        );
      }
      return Promise.resolve(value);
    },
  };
}

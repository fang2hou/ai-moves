import type { SecretProvider } from "@ai-moves/contracts/ports/runtime";
import { AppError } from "@ai-moves/kernel/errors/app-error";

// Holds placeholder values only. Real secrets never enter the test suite.
export function createStaticSecretProvider(
  secrets: Readonly<Record<string, string>>,
): SecretProvider {
  return {
    get: (ref) => {
      const value = Object.hasOwn(secrets, ref) ? secrets[ref] : undefined;
      return value === undefined
        ? Promise.reject(
            new AppError("SECRET_MISSING", { message: `SECRET_MISSING: ${ref}`, context: { ref } }),
          )
        : Promise.resolve(value);
    },
  };
}

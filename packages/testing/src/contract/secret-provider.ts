import type { SecretProvider } from "@ai-moves/contracts/ports/runtime";
import { expect } from "vitest";

import { definePortContract } from "./define.ts";

export const SECRET_PROVIDER_FIXTURES = {
  TEST_PRIMARY: "synthetic-primary",
  TEST_SECONDARY: "synthetic-secondary",
} as const;

export const secretProviderContract = definePortContract<SecretProvider>("SecretProvider", [
  {
    name: "resolves only the value bound to the requested reference",
    run: async (provider) => {
      for (const [ref, value] of Object.entries(SECRET_PROVIDER_FIXTURES)) {
        await expect(provider.get(ref)).resolves.toBe(value);
      }
    },
  },
  {
    name: "rejects an unbound reference with a permanent SECRET_MISSING error",
    run: async (provider) => {
      await expect(provider.get("TEST_UNBOUND")).rejects.toMatchObject({
        code: "SECRET_MISSING",
        kind: "permanent",
      });
    },
  },
]);

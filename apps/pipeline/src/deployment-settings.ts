import type { SecretProvider } from "@ai-news-tracker/contracts/ports/runtime";
import { AppError } from "@ai-news-tracker/kernel/errors/app-error";

// The desk origin is written into every published link, so it must be a bare HTTPS origin.
export function parseDeskOrigin(value: unknown): string {
  const origin = typeof value === "string" ? URL.parse(value) : null;
  if (
    origin === null ||
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.href.length > 1800
  ) {
    throw new AppError("CONFIG_INVALID", { message: "DESK_ORIGIN must be an HTTPS origin" });
  }
  return origin.origin;
}

// Provider secrets go into request headers, where stray whitespace silently breaks
// authentication; reject them instead.
export function rejectWhitespace(secrets: SecretProvider): SecretProvider {
  return {
    async get(ref) {
      const token = await secrets.get(ref);
      if (/\s/u.test(token)) {
        throw new AppError("CONFIG_INVALID", { message: "Provider secret contains whitespace" });
      }
      return token;
    },
  };
}

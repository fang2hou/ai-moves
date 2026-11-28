import type { ErrorCode } from "@ai-news-tracker/contracts/errors";
import { AppError } from "@ai-news-tracker/kernel/errors/app-error";

export function missingBinding(code: ErrorCode, binding: string): AppError {
  return new AppError(code, {
    message: `${code}: Cloudflare binding ${binding} is not available`,
    context: { binding },
  });
}

export function platformFailure(code: ErrorCode, operation: string, cause: unknown): AppError {
  if (cause instanceof AppError) {
    return cause;
  }
  return new AppError(code, {
    message: `${code}: Cloudflare ${operation} failed`,
    cause,
  });
}

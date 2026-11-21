import { CONTRACT_VERSION } from "@ai-moves/contracts/version";
import { AppError } from "@ai-moves/kernel/errors/app-error";

export function describe(error: AppError): string {
  return `${CONTRACT_VERSION}:${error.code}`;
}

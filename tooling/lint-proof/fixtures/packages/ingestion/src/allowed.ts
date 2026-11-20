import { CONTRACT_VERSION } from "@ai-moves/contracts";
import { AppError } from "@ai-moves/kernel";

export function describe(error: AppError): string {
  return `${CONTRACT_VERSION}:${error.code}`;
}

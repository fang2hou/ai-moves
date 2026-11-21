import { type AppError, toAppError } from "./errors/app-error.ts";

export type Result<Value, Failure = AppError> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Failure };

export function ok<Value>(value: Value): Result<Value, never> {
  return { ok: true, value };
}

export function err<Failure>(error: Failure): Result<never, Failure> {
  return { ok: false, error };
}

// Runs an operation and returns its failure as a classified value instead of throwing.
export async function attempt<Value>(operation: () => Promise<Value>): Promise<Result<Value>> {
  try {
    return ok(await operation());
  } catch (error) {
    return err(toAppError(error));
  }
}

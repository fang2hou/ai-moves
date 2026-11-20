import { AppError } from "@ai-moves/kernel/errors/app-error";

export type ScriptStep<Output> =
  | { readonly kind: "return"; readonly value: Output }
  | { readonly kind: "reject"; readonly error: AppError };

interface ScriptedMethod<Args extends readonly unknown[], Output> {
  readonly calls: readonly Args[];
  readonly run: (...args: Args) => Promise<Output>;
}

export function scriptedMethod<Args extends readonly unknown[], Output>(
  method: string,
  steps: readonly ScriptStep<Output>[] = [],
): ScriptedMethod<Args, Output> {
  const calls: Args[] = [];
  return {
    calls,
    run: (...args) => {
      const step = steps[calls.length];
      calls.push(args);
      if (step === undefined) {
        return Promise.reject(
          new AppError("INPUT_INVALID", { message: `Unscripted ${method} call` }),
        );
      }
      return step.kind === "reject" ? Promise.reject(step.error) : Promise.resolve(step.value);
    },
  };
}

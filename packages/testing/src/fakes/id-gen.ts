import type { IdGen } from "@ai-moves/contracts/ports/runtime";

// Predictable ids: `id_000001`, `id_000002`, ...
export function createSequentialIdGen(prefix = "id"): IdGen {
  let counter = 0;
  return {
    next: () => {
      counter += 1;
      return `${prefix}_${String(counter).padStart(6, "0")}`;
    },
  };
}

import type { Clock } from "@ai-moves/contracts/ports/runtime";

export const systemClock: Clock = {
  now: () => Date.now(),
};

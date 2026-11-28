import type { Clock } from "@ai-news-tracker/contracts/ports/runtime";

export const systemClock: Clock = {
  now: () => Date.now(),
};

import type { AppConfig } from "@ai-moves/contracts/config";
import type { HnRelevanceJudge, LlmClient } from "@ai-moves/contracts/ports/llm";
import type { TraceId } from "@ai-moves/contracts/primitives";
import type { HnRelevance } from "@ai-moves/contracts/scoring";
import { AppError, toAppError } from "@ai-moves/kernel/errors/app-error";
import type { Logger } from "@ai-moves/kernel/logger";
import { renderHnRelevancePrompt } from "@ai-moves/prompts/relevance";

export interface HnRelevanceDependencies {
  // Opened on first use, so a poll with nothing to judge never reads provider secrets.
  readonly llm: () => Promise<Pick<LlmClient, "generateStructured">>;
  readonly profile: Pick<AppConfig["profile"], "topics" | "products">;
  readonly logger: Pick<Logger, "info" | "warn">;
  readonly traceId: TraceId;
}

// A failed call leaves every story unjudged rather than failing the poll that asked.
export function createHnRelevanceJudge(deps: HnRelevanceDependencies): HnRelevanceJudge {
  return async (stories) => {
    const request = renderHnRelevancePrompt({
      traceId: deps.traceId,
      topics: deps.profile.topics,
      products: deps.profile.products,
      stories,
    });
    try {
      const llm = await deps.llm();
      const result = await llm.generateStructured(request);
      const asked = new Set(stories.map((story) => story.id));
      const verdicts = new Map<string, HnRelevance>();
      for (const { id, relevance } of result.output.stories) {
        if (asked.has(id)) verdicts.set(id, relevance);
      }
      deps.logger.info("analysis.hn_relevance_judged", {
        attrs: {
          asked: stories.length,
          judged: verdicts.size,
          model: result.model,
          prompt_version: request.promptVersion,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        },
      });
      return verdicts;
    } catch (cause) {
      deps.logger.warn("analysis.hn_relevance_failed", {
        err: new AppError(toAppError(cause).code),
        attrs: { asked: stories.length },
      });
      return new Map();
    }
  };
}

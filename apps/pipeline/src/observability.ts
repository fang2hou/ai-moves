import type { Telemetry } from "@ai-moves/contracts/ports/runtime";
import type { AnalysisRepo, ItemRepo } from "@ai-moves/contracts/ports/storage";
import type { Logger } from "@ai-moves/kernel/logger";

export function bestEffortTelemetry(sink: Telemetry): Telemetry {
  // Observability must not turn a committed write into a failed job or prevent a sibling retry.
  return {
    log(record) {
      try {
        sink.log(record);
      } catch {
        return;
      }
    },
    count(metric, value, dimensions) {
      try {
        sink.count(metric, value, dimensions);
      } catch {
        return;
      }
    },
  };
}

export function observeItems(repo: ItemRepo, logger: Logger, stage: "triage" | "deep"): ItemRepo {
  return {
    ...repo,
    async transition(change) {
      const won = await repo.transition(change);
      if (won) {
        logger.info("pipeline.item_transition", {
          stage,
          attrs: {
            from: change.from,
            state: change.to,
            attempt: change.patch?.attempts ?? change.expected?.attempts,
            retry_scheduled: typeof change.patch?.next_attempt_at === "number",
          },
        });
      }
      return won;
    },
  };
}

export function observeAnalyses(
  repo: AnalysisRepo,
  logger: Logger,
  stage: "triage" | "deep",
): AnalysisRepo {
  return {
    ...repo,
    async complete(id, owner, completion) {
      const won = await repo.complete(id, owner, completion);
      if (won) {
        logger.info("pipeline.analysis_completed", {
          stage,
          attrs: { state: completion.status, code: completion.error_code },
        });
      }
      return won;
    },
  };
}

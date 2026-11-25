import type { Analysis, AnalysisKey } from "@ai-moves/contracts/entities";
import type { AnalysisRepo, Inserted } from "@ai-moves/contracts/ports/storage";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { validateLease } from "@ai-moves/storage/rules";

import { revCondition } from "./client.ts";
import { execute, inserted, settled, requireNoConflict, type StorageContext } from "./context.ts";
import { keys, uniqueKey } from "./keys.ts";
import { analysisRecord, decodeAnalysis, decodeAnalysisLease, loaded } from "./records.ts";

async function analysisKeyMarker(analysis: AnalysisKey) {
  return uniqueKey(
    "analysis_key",
    [
      analysis.item_id,
      analysis.stage,
      analysis.input_hash,
      analysis.prompt_version,
      analysis.lang,
    ].join("\0"),
  );
}

export function createAnalysisRepo(context: StorageContext): AnalysisRepo {
  const { table, optimistic, read, resolveMarker, insertUnique } = context;

  const analyses: AnalysisRepo = {
    async insertIfAbsent(analysis): Promise<Inserted<Analysis>> {
      return execute(async () => {
        const marker = await analysisKeyMarker(analysis);
        const existing = await resolveMarker(marker, keys.analysis, decodeAnalysis);
        if (existing !== null) return inserted(existing.value, false);
        const record = analysisRecord(analysis, { owner: null, expiresAt: null }, 1);
        const outcome = await insertUnique(record, marker, analysis.id);
        requireNoConflict(outcome, "TransactWriteItems");
        if (outcome.kind === "condition") {
          const replay = await resolveMarker(marker, keys.analysis, decodeAnalysis);
          if (replay !== null) return inserted(replay.value, false);
          throw new AppError("STATE_CONFLICT");
        }
        return inserted(analysis, true);
      });
    },
    async get(id): Promise<Analysis | null> {
      return execute(() => read(keys.analysis(id), decodeAnalysis));
    },
    async findByKey(key): Promise<Analysis | null> {
      return execute(async () => {
        const marker = await analysisKeyMarker(key);
        return (await resolveMarker(marker, keys.analysis, decodeAnalysis))?.value ?? null;
      });
    },
    async claim(id, lease): Promise<boolean> {
      validateLease(lease);
      return execute(() =>
        optimistic(async () => {
          const row = await table.get(keys.analysis(id));
          if (row === null) return false;
          const current = loaded(row, decodeAnalysis);
          const held = decodeAnalysisLease(row);
          if (
            current.value.status !== "pending" ||
            (held.expiresAt !== null && held.expiresAt > lease.now)
          ) {
            return false;
          }
          return settled(
            await table.put(
              analysisRecord(
                current.value,
                { owner: lease.owner, expiresAt: lease.expiresAt },
                current.rev + 1,
              ),
              revCondition(current.rev),
            ),
            true,
          );
        }),
      );
    },
    async complete(id, owner, completion): Promise<boolean> {
      return execute(() =>
        optimistic(async () => {
          const row = await table.get(keys.analysis(id));
          if (row === null) return false;
          const current = loaded(row, decodeAnalysis);
          const held = decodeAnalysisLease(row);
          if (
            current.value.status !== "pending" ||
            held.owner !== owner ||
            held.expiresAt === null ||
            held.expiresAt <= completion.at
          ) {
            return false;
          }
          const next: Analysis = {
            ...current.value,
            status: completion.status,
            output_json: completion.output_json,
            blob_key: completion.blob_key,
            usage_json: completion.usage_json,
            error_code: completion.error_code,
            updated_at: completion.at,
          };
          return settled(
            await table.put(
              analysisRecord(next, { owner: null, expiresAt: null }, current.rev + 1),
              revCondition(current.rev),
            ),
            true,
          );
        }),
      );
    },
  };

  return analyses;
}

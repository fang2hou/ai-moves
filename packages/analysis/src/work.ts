import { stageModels, type AppConfig } from "@ai-moves/contracts/config";
import type { Analysis, AnalysisKey, Item, LlmUsage } from "@ai-moves/contracts/entities";
import type { ErrorCode } from "@ai-moves/contracts/errors";
import type { GenerateStructuredRequest, LlmClient } from "@ai-moves/contracts/ports/llm";
import type { Clock, IdGen } from "@ai-moves/contracts/ports/runtime";
import type {
  AnalysisRepo,
  BlobStore,
  BudgetLedger,
  BudgetRequest,
  ItemRepo,
} from "@ai-moves/contracts/ports/storage";
import type { JsonValue, Lang } from "@ai-moves/contracts/primitives";
import type { AnalysisStage, ItemState } from "@ai-moves/contracts/states";
import { analysisKey, stableKey } from "@ai-moves/core/idempotency";
import { AppError, toAppError } from "@ai-moves/kernel/errors/app-error";
import { PROMPT_VERSIONS } from "@ai-moves/prompts/versions";
import type { ZodType } from "zod";

const MINUTE = 60_000;
const MAX_BACKOFF = 15 * MINUTE;
const JSON_BLOB = { contentType: "application/json" };

export interface AnalysisDependencies {
  readonly items: Pick<ItemRepo, "get" | "transition">;
  readonly analyses: Pick<AnalysisRepo, "findByKey" | "insertIfAbsent" | "claim" | "complete">;
  readonly blobs: Pick<BlobStore, "get" | "put">;
  readonly budgets: Pick<BudgetLedger, "tryConsume">;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly llm: LlmClient;
  readonly config: AppConfig;
  readonly configVersion: number;
}

type ItemStage = "triage" | "deep";
const states = {
  triage: { ready: "candidate", working: "triaging" },
  deep: { ready: "triaged_pass", working: "analyzing" },
} as const satisfies Record<ItemStage, { ready: ItemState; working: ItemState }>;

export interface ItemClaim {
  readonly item: Item;
  readonly stage: ItemStage;
  readonly expiresAt: number;
}

export async function claimItem(
  deps: AnalysisDependencies,
  observed: Item,
  stage: ItemStage,
): Promise<ItemClaim | null> {
  const now = deps.clock.now();
  const { ready, working } = states[stage];
  if (observed.state !== ready || (observed.next_attempt_at ?? 0) > now) return null;

  const attempts = observed.attempts + 1;
  const won = await deps.items.transition({
    id: observed.id,
    from: ready,
    to: working,
    expected: observed,
    at: now,
    patch: { attempts, next_attempt_at: null },
  });
  if (!won) return null;
  const minutes =
    stage === "triage" ? deps.config.leases.triage_minutes : deps.config.leases.deep_minutes;
  return {
    item: { ...observed, state: working, state_updated_at: now, attempts, next_attempt_at: null },
    stage,
    expiresAt: now + minutes * MINUTE,
  };
}

const COMMENT_BUCKET = 10;

export function itemSnapshotHash(item: Item): string {
  return stableKey(
    "analysis-input-v1",
    item.external_key,
    item.kind,
    item.title,
    item.url ?? "",
    item.content_hash ?? "",
    String(item.revision),
    // A refresh must not reuse the previous analysis. Bucketing keeps the key
    // stable across a single run while still changing once the discussion grows.
    item.score_json?.kind === "hn"
      ? String(Math.floor(item.score_json.features.comments / COMMENT_BUCKET))
      : "",
  );
}

export function executionKey(
  itemId: string,
  stage: AnalysisStage,
  inputHash: string,
  lang: Lang = "en",
): AnalysisKey {
  return {
    item_id: itemId,
    stage,
    input_hash: inputHash,
    prompt_version: PROMPT_VERSIONS[stage],
    lang,
  };
}

type AnalysisOutcome =
  | { readonly kind: "completed"; readonly row: Analysis }
  | { readonly kind: "retry"; readonly retryAfterMs: number }
  | { readonly kind: "stopped" }
  | { readonly kind: "exhausted" };

interface AnalysisSpec<Input, Output> {
  readonly key: AnalysisKey;
  readonly additionalBudget?: () => Promise<Pick<BudgetRequest, "scope" | "limit"> | null>;
  readonly inputSchema: ZodType<Input>;
  readonly prepare: () => Promise<Input>;
  readonly prompt: (input: Input) => GenerateStructuredRequest<Output>;
  readonly normalize: (output: Output, input: Input) => JsonValue;
}

export async function runAnalysis<Input, Output>(
  deps: AnalysisDependencies,
  claim: ItemClaim,
  spec: AnalysisSpec<Input, Output>,
): Promise<AnalysisOutcome> {
  let row = await deps.analyses.findByKey(spec.key);
  if (row !== null && row.status !== "pending") return { kind: "completed", row };
  if (!(await ownsItem(deps, claim))) return { kind: "stopped" };
  const maxAttempts = deps.config.retry.analysis.max_queue_retries + 1;
  if (claim.item.attempts > maxAttempts) return { kind: "exhausted" };

  let prepared: Input | undefined;
  if (row === null) {
    try {
      prepared = await spec.prepare();
    } catch (cause) {
      const error = toAppError(cause);
      if (error.kind === "retryable" && claim.item.attempts < maxAttempts) {
        return { kind: "retry", retryAfterMs: error.retryAfterMs ?? 0 };
      }
      throw error;
    }
    const ref = await deps.blobs.put(JSON.stringify(prepared), JSON_BLOB);
    const now = deps.clock.now();
    if (now >= claim.expiresAt) return { kind: "stopped" };
    const inserted = await deps.analyses.insertIfAbsent({
      ...spec.key,
      id: analysisKey({
        itemId: spec.key.item_id,
        stage: spec.key.stage,
        inputHash: spec.key.input_hash,
        promptVersion: spec.key.prompt_version,
        lang: spec.key.lang,
      }),
      model: stageModels(deps.config.models)[spec.key.stage].model,
      config_version: deps.configVersion,
      status: "pending",
      output_json: null,
      r2_key: ref.key,
      usage_json: null,
      error_code: null,
      created_at: now,
      updated_at: now,
    });
    row = inserted.value;
    if (!inserted.created) prepared = undefined;
    if (row.status !== "pending") return { kind: "completed", row };
  }

  const input = prepared ?? (await readAnalysisInput(deps.blobs, row, spec.inputSchema));
  const now = deps.clock.now();
  if (now >= claim.expiresAt) return { kind: "stopped" };
  const owner = deps.ids.next();
  if (!(await deps.analyses.claim(row.id, { owner, now, expiresAt: claim.expiresAt }))) {
    return { kind: "stopped" };
  }

  let output: JsonValue | null = null;
  let usage: LlmUsage | null = null;
  let errorCode: ErrorCode | null = null;
  try {
    const request = spec.prompt(input);
    if (!deps.config.ai.enabled) throw new AppError("BUDGET_EXHAUSTED");
    const additionalBudget = await spec.additionalBudget?.();
    if (!(await ownsItem(deps, claim))) return { kind: "stopped" };
    const day = new Date(deps.clock.now()).toISOString().slice(0, 10);
    if (additionalBudget) {
      // A capped repository must not spend the shared budget on a denied model call.
      const grant = await deps.budgets.tryConsume({
        ...additionalBudget,
        workId: owner,
        day,
        amount: 1,
      });
      if (!grant.granted) throw new AppError("BUDGET_EXHAUSTED");
      if (!(await ownsItem(deps, claim))) return { kind: "stopped" };
    }
    const grant = await deps.budgets.tryConsume({
      workId: owner,
      day,
      scope: `ai:${spec.key.stage}`,
      amount: 1,
      limit:
        spec.key.stage === "triage"
          ? deps.config.ai.triage_items_per_day
          : deps.config.ai.deep_per_day,
    });
    if (!grant.granted) throw new AppError("BUDGET_EXHAUSTED");
    if (!(await ownsItem(deps, claim))) return { kind: "stopped" };
    const result = await deps.llm.generateStructured(request);
    usage = result.usage;
    const validated = request.schema.safeParse(result.output);
    if (!validated.success) throw new AppError("LLM_OUTPUT_INVALID");
    output = {
      value: spec.normalize(validated.data, input),
      model: result.model,
      repaired: result.repaired,
      used_fallback: result.usedFallback,
      config_version: deps.configVersion,
    };
  } catch (cause) {
    const error = toAppError(cause);
    if (error.kind === "retryable" && claim.item.attempts < maxAttempts) {
      return {
        kind: "retry",
        retryAfterMs: Math.max(error.retryAfterMs ?? 0, claim.expiresAt - deps.clock.now()),
      };
    }
    errorCode = error.code;
  }

  if (!(await ownsItem(deps, claim))) return { kind: "stopped" };
  const at = deps.clock.now();
  const completion = {
    status: errorCode === null ? "succeeded" : "failed",
    at,
    r2_key: row.r2_key,
    output_json: output,
    usage_json: usage,
    error_code: errorCode,
  } as const;
  if (!(await deps.analyses.complete(row.id, owner, completion))) return { kind: "stopped" };
  const { at: updated_at, ...fields } = completion;
  return { kind: "completed", row: { ...row, ...fields, updated_at } };
}

export async function readAnalysisInput<Input>(
  blobs: Pick<BlobStore, "get">,
  row: Analysis,
  schema: ZodType<Input>,
): Promise<Input> {
  const body = row.r2_key === null ? null : await blobs.get(row.r2_key);
  if (body === null)
    throw new AppError("STORAGE_UNAVAILABLE", { message: "Missing analysis input" });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (cause) {
    throw new AppError("ROW_INVALID", { cause });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("ROW_INVALID");
  return parsed.data;
}

export function readOutput<Output>(row: Analysis, schema: ZodType<Output>): Output | null {
  if (row.status !== "succeeded") return null;
  const output = row.output_json;
  if (output === null || typeof output !== "object" || !("value" in output)) {
    throw new AppError("ROW_INVALID");
  }
  const parsed = schema.safeParse(output["value"]);
  if (!parsed.success) throw new AppError("ROW_INVALID");
  return parsed.data;
}

export async function advanceItem(
  deps: AnalysisDependencies,
  claim: ItemClaim,
  state: ItemState,
  options: { at?: number; retryAt?: number; attempts?: number } = {},
): Promise<boolean> {
  const now = options.at ?? deps.clock.now();
  if (now >= claim.expiresAt) return false;
  return deps.items.transition({
    id: claim.item.id,
    from: claim.item.state,
    to: state,
    expected: claim.item,
    at: now,
    patch: {
      attempts: options.attempts ?? (options.retryAt === undefined ? 0 : claim.item.attempts),
      next_attempt_at: options.retryAt ?? null,
    },
  });
}

export async function retryItem(
  deps: AnalysisDependencies,
  claim: ItemClaim,
  retryAfterMs: number,
): Promise<void> {
  const backoff = Math.min(MAX_BACKOFF, 30_000 * 2 ** (claim.item.attempts - 1));
  const jitter =
    Number.parseInt(
      stableKey("analysis-backoff", claim.item.id, String(claim.item.attempts)).slice(0, 4),
      16,
    ) % 5000;
  await advanceItem(deps, claim, states[claim.stage].ready, {
    retryAt: deps.clock.now() + Math.max(backoff + jitter, retryAfterMs),
  });
}

async function ownsItem(deps: AnalysisDependencies, claim: ItemClaim): Promise<boolean> {
  const current = await deps.items.get(claim.item.id);
  return (
    current !== null &&
    current.state === claim.item.state &&
    current.attempts === claim.item.attempts &&
    current.state_updated_at === claim.item.state_updated_at &&
    deps.clock.now() < claim.expiresAt
  );
}

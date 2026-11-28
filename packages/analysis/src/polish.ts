import type { AlertDoc } from "@ai-news-tracker/contracts/alert-doc";
import type { TraceId } from "@ai-news-tracker/contracts/primitives";
import { stableKey } from "@ai-news-tracker/core/idempotency";
import { PolishOutputSchema, renderPolishPrompt } from "@ai-news-tracker/prompts/polish";

import { cleanModelText } from "./finalization.ts";
import {
  executionKey,
  readOutput,
  runAnalysis,
  type AnalysisDependencies,
  type ItemClaim,
} from "./work.ts";

export type PolishResult =
  | { readonly kind: "ready"; readonly document: AlertDoc }
  | { readonly kind: "retry"; readonly retryAfterMs: number }
  | { readonly kind: "stopped" };

// A second reading of the finished document, by a model whose only job is to repair
// it. The result is accepted only where it is plainly an improvement on the same
// facts; anything else falls back to the document that went in, so a bad pass costs
// a call and changes nothing.
export async function polishDocument(
  deps: AnalysisDependencies,
  claim: ItemClaim,
  deepId: string,
  original: AlertDoc,
  traceId: TraceId,
): Promise<PolishResult> {
  const points = original.key_points.filter(({ evidence_quote }) => evidence_quote === null);
  if (points.length === 0) return { kind: "ready", document: original };
  const outcome = await runAnalysis(deps, claim, {
    key: polishKey(claim.item.id, deepId, original),
    inputSchema: PolishOutputSchema,
    prepare: () =>
      Promise.resolve({
        summary: original.summary,
        key_points: points.map(({ text, implication }) => ({ text, implication })),
      }),
    prompt: (input) =>
      renderPolishPrompt({
        traceId,
        lang: original.lang,
        summary: input.summary,
        points: input.key_points,
      }),
    normalize: (polished) => polished,
  });
  if (outcome.kind === "retry" || outcome.kind === "stopped") return outcome;
  if (outcome.kind !== "completed") return { kind: "ready", document: original };
  const output = readOutput(outcome.row, PolishOutputSchema);
  return {
    kind: "ready",
    document: output === null ? original : applied(original, output),
  };
}

export async function readPolishedDocument(
  deps: AnalysisDependencies,
  itemId: string,
  deepId: string,
  original: AlertDoc,
): Promise<AlertDoc> {
  const row = await deps.analyses.findByKey(polishKey(itemId, deepId, original));
  const output = row === null ? null : readOutput(row, PolishOutputSchema);
  return output === null ? original : applied(original, output);
}

// The pass may rewrite a field but not change what the document is: a different
// number of points, or an empty field, means the answer is discarded.
function applied(
  original: AlertDoc,
  polished: {
    readonly summary: string;
    readonly key_points: readonly { readonly text: string; readonly implication: string | null }[];
  },
): AlertDoc {
  const expected = original.key_points.filter(
    ({ evidence_quote }) => evidence_quote === null,
  ).length;
  if (polished.key_points.length !== expected || polished.summary.trim() === "") return original;
  // The pass is told to take leaked citations back off, but it is still a model, so
  // its answer gets the cleaning the first draft got. A field left with nothing
  // readable keeps the text that went in: the count is pinned, so a point cannot be
  // dropped for being uncleanable.
  let index = 0;
  const key_points = original.key_points.map((point) => {
    if (point.evidence_quote !== null) return point;
    const next = polished.key_points[index++];
    if (next === undefined || next.text.trim() === "") return point;
    return {
      ...point,
      text: cleanModelText(next.text) ?? point.text,
      implication:
        next.implication === null || next.implication.trim() === ""
          ? null
          : (cleanModelText(next.implication) ?? point.implication),
    };
  });
  return {
    ...original,
    summary: cleanModelText(polished.summary) ?? original.summary,
    key_points,
  };
}

function polishKey(
  itemId: string,
  deepId: string,
  document: AlertDoc,
): ReturnType<typeof executionKey> {
  return executionKey(
    itemId,
    "polish",
    stableKey(
      deepId,
      document.lang,
      document.summary,
      ...document.key_points.map(({ text, implication }) => `${text}\u0000${implication ?? ""}`),
    ),
    document.lang,
  );
}

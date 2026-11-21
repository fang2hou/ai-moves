import {
  ChangelogDeepAssessmentSchema,
  type ChangelogDeepAssessment,
  HnDeepAssessmentSchema,
  type HnDeepAssessment,
} from "@ai-moves/contracts/analysis";
import type { TraceId } from "@ai-moves/contracts/primitives";
import type { ItemKind } from "@ai-moves/contracts/states";

import { renderPrompt, type RenderedPrompt } from "./render.ts";

export interface DeepPromptInput<Kind extends ItemKind = ItemKind> {
  readonly traceId: TraceId;
  readonly kind: Kind;
  readonly title: string;
  readonly topics: readonly string[];
  readonly evidence: readonly { readonly locator: string; readonly text: string }[];
}

const instructions = [
  "Analyze this item for engineers interested in the supplied topics. Write in English.",
  "Explain what happened, why it matters now, practical implications, and caveats. Distinguish source claims from your inference.",
  "Use only supplied evidence. For each citation, copy a supplied locator and a short verbatim quote from its text. Never invent a locator, quotation, or URL.",
  "Set confidence from 0 to 1 according to the strength of the evidence. Leave unsupported lists empty. Do not decide whether to send an alert.",
];

export const HnDeepOutputSchema = HnDeepAssessmentSchema;
export const ChangelogDeepOutputSchema = ChangelogDeepAssessmentSchema;

export function renderDeepPrompt(input: DeepPromptInput<"hn">): RenderedPrompt<HnDeepAssessment>;
export function renderDeepPrompt(
  input: DeepPromptInput<"changelog">,
): RenderedPrompt<ChangelogDeepAssessment>;
export function renderDeepPrompt(
  input: DeepPromptInput,
): RenderedPrompt<HnDeepAssessment | ChangelogDeepAssessment>;
export function renderDeepPrompt({
  traceId,
  kind,
  title,
  topics,
  evidence,
}: DeepPromptInput): RenderedPrompt<HnDeepAssessment | ChangelogDeepAssessment> {
  const data = { kind, title, topics, evidence };
  if (kind === "hn") {
    return renderPrompt(
      "deep",
      HnDeepOutputSchema,
      traceId,
      [
        ...instructions,
        "Return kind hn. Score importance from 1 (niche) to 5 (substantial consequences for engineering practice).",
      ],
      data,
      kind,
    );
  }
  return renderPrompt(
    "deep",
    ChangelogDeepOutputSchema,
    traceId,
    [
      ...instructions,
      "Return kind changelog. Score impact from 0 (no meaningful change) to 3 (breaking change or major workflow shift).",
    ],
    data,
    kind,
  );
}

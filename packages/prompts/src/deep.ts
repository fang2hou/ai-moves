import {
  ChangelogDeepAssessmentSchema,
  type ChangelogDeepAssessment,
  HnDeepAssessmentSchema,
  type HnDeepAssessment,
} from "@ai-moves/contracts/analysis";
import type { Lang, TraceId } from "@ai-moves/contracts/primitives";
import type { ItemKind } from "@ai-moves/contracts/states";
import { getLocale } from "@ai-moves/locales/registry";

import { renderPrompt, type RenderedPrompt } from "./render.ts";

export interface DeepPromptInput<Kind extends ItemKind = ItemKind> {
  readonly traceId: TraceId;
  readonly kind: Kind;
  readonly title: string;
  readonly topics: readonly string[];
  readonly products: readonly string[];
  readonly lang: Lang;
  readonly evidence: readonly { readonly locator: string; readonly text: string }[];
  readonly prior?:
    | {
        readonly summary: string;
        readonly key_points: readonly string[];
        readonly community_view: string | null;
      }
    | null
    | undefined;
}

// What holds whatever the subject is: how the two surfaces render text, where a
// citation may appear, and the internal fields. Everything about what to write lives
// in the per-kind list below, because a release and a discussion have almost nothing
// in common beyond the shape of the output.
const commonInstructions = [
  'Report the subject itself. Never refer to the supplied material as "the item", "the post", "the article", "the guide" or "the discussion": write the finding directly.',
  // Both surfaces that print these fields render inline code and nothing else, so
  // that is the whole of the markup budget.
  "Wrap an identifier, command, flag, path, setting key or version string in single backticks, as in `claude auth login` or `todo.backend`. A product name, a model name, a plan name and ordinary prose stay bare: write Antigravity and Gemini 4 Neon, never `Antigravity`. Use no other markup anywhere: no asterisks, hash signs, underscores, bullet characters, headings, tables or bracketed links, and never a code block.",
  "Use only supplied evidence. For each citation, copy a supplied locator and a short verbatim quote from its text, in the language the evidence is written in and character for character. Never invent, translate or tidy a locator, quotation, or URL.",
  // Every link on the card is written by the program from a field it owns. A model
  // that appends one to its prose is overwriting a record it cannot see.
  'Citations go in the citations field and nowhere else. Never write a URL, a domain name, a numbered marker such as [1] or [citation:1], or a phrase such as "Source:", "Reference:" or "\u5f15\u7528\uff1a" inside summary, a point\u2019s text or a point\u2019s implication. Those fields are prose and end with the sentence.',
  "Set why_now to one sentence on why this is worth publishing now; it is an internal note, not part of the page.",
  "Set confidence from 0 to 1 according to the strength of the evidence. Leave unsupported lists empty. Do not decide whether to send an alert.",
];

// A release note. The reader runs this tool by hand and wants the few changes that
// will touch their own use of it.
const changelogInstructions = [
  "Write a quick preview for one engineer deciding whether to upgrade. They want the few changes that matter, each stated once, in plain words.",
  "Keep summary to one or two sentences, 220 characters at the most, stating what changed. Do not argue that it is important and do not restate the title.",
  "key_points carries the whole reading. Each point has a text field holding exactly one change, one or two sentences and 180 characters at the most, standing on its own. Two changes mean two points, or one of them is left out; a point that lists several is wrong even when every item in it is true. Order the points by how much they affect ordinary use and give at most six.",
  // A point that names only a category is unreadable: the reader cannot tell whether
  // it touches anything they use.
  'Name the specifics the evidence names: model names, version numbers, commands, settings, keys and defaults. "Added GPT-6.2 Sol and Astra to the model catalog, with Sol as the default" is a point; "expanded model discovery" is not.',
  // The page prints the implication as a labelled line of its own, so it must not be
  // glued to the change and must not be written for every point.
  "A point's implication field is one sentence of at most 120 characters, saying what the change means in practice and nothing else: a fixed session-cache bug means a plan's quota goes further, a changed default means an existing habit stops working. One sentence, stated plainly, with no linking phrase back to the change. Use null unless the consequence is something the reader would not work out from the change itself; restating the change in other words is worse than leaving it null.",
  "Do not restate the product name or the version number inside a point; the title already carries both.",
  // The reader is a working engineer using the tool by hand, not a platform team
  // wiring it into automation. Advice they would never act on reads as filler.
  "Keep a point only when someone using this by hand would notice it: a workflow that changes, a default that moves, something that now works or stops working. Leave out what only matters to automation scripts, CI, API consumers or agent harnesses unless ordinary use breaks too, and leave out narrow edge cases. Three solid points beat six padded ones.",
];

// A discussion. There is no release to sort and no upgrade to decide: the reader
// wants to know what was claimed and what the room made of it.
const hnInstructions = [
  "Write a short briefing for a curious reader who has not opened the link and is not a specialist in this subject.",
  "Keep summary to one or two sentences, 220 characters at the most: what this is and what is being claimed. Do not restate the title and do not say that it is interesting.",
  "key_points carries the whole reading, at most six points, each one or two sentences and 180 characters at the most, standing on its own. Spend them on what the piece actually says and on where the discussion lands: the claim being made, the part people found convincing, the part they pushed back on, and anything a commenter knows first-hand that the piece does not.",
  "Explain before you judge: say what the thing is before saying what is notable about it, spell out an acronym the first time, and prefer a plain word to the term of art when both are accurate.",
  "A point's implication field is what this means for the reader, one plain sentence. Use null whenever the point already says it; most points need none.",
  "Leave out vote counts, karma, rankings, who said it and how many people said it. Describe the balance of opinion in words.",
  "Give no advice the discussion does not support, and do not predict what will happen next.",
];

const communityInstruction =
  "Set community_view from the discussion: overall mood, a short prose summary, and the strongest supporting and opposing arguments. Describe the balance in words; never report percentages or vote counts. Use null when the evidence contains no discussion.";

const refreshInstruction =
  "A prior reading of this same item is supplied. Update it with what the newer evidence adds or changes, and return a complete standalone result, not a diff or a changelog of your own edits. Never mention that a previous version existed.";

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
  products,
  evidence,
  lang,
  prior,
}: DeepPromptInput): RenderedPrompt<HnDeepAssessment | ChangelogDeepAssessment> {
  const { englishName, prompt } = getLocale(lang);
  const data = { kind, title, topics, products, evidence, lang, prior: prior ?? null };
  const shared = [
    ...commonInstructions,
    ...(kind === "hn" ? hnInstructions : changelogInstructions),
    `Write every prose field in ${englishName}, naturally, as a writer of that language would. Keep identifiers, commands, product names, version strings and URLs exactly as they appear in the source. Citation quotes are the exception: leave them in their original language, unchanged.`,
    ...prompt.writingRules,
    ...(products.length === 0
      ? []
      : [
          `The reader uses ${products.join(", ")}. Keep a change that touches one of these even when it looks minor, and say which one it touches.`,
        ]),
    `Set headline to the source title rewritten in ${englishName}, or null when it is already in that language.`,
    communityInstruction,
    ...(prior === null || prior === undefined ? [] : [refreshInstruction]),
  ];
  if (kind === "hn") {
    return renderPrompt(
      "deep",
      HnDeepOutputSchema,
      traceId,
      [
        ...shared,
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
      ...shared,
      "Return kind changelog. Score impact from 0 (no meaningful change) to 3 (breaking change or major workflow shift).",
      // The card groups the points under these four headings, so the grouping is only
      // as useful as the model's choice here.
      'Set each point\'s category: "breaking" when something that worked stops working or is removed, "new" for a capability that did not exist, "change" for a default, behaviour or workflow that moved, "fix" for a bug that is now fixed. When a point fits two, take the one a reader would care about more, in that order.',
      "The evidence is one release of one product. Cover that release only, and name its version where the evidence gives one.",
      "Most release notes are routine. Skip performance work, dependency bumps and ordinary bug fixes entirely, or give them one closing point between them. Spend the points on new surface, changed defaults and anything that changes how the tool is used by hand.",
    ],
    data,
    kind,
  );
}

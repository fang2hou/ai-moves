import type { AlertDoc, AlertPoint } from "@ai-moves/contracts/alert-doc";
import type { PointCategory } from "@ai-moves/contracts/analysis";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { publicLink } from "@ai-moves/kernel/public-links";
import { getLocale } from "@ai-moves/locales/registry";

import { CODE_SPAN, plainText, unlinked, withoutCodeMarks } from "./markup.ts";

// Block Kit limits: 150 characters in a header, 75 in a button label, and 3000 in a
// button URL and in a context element. Rich text has no documented per-block limit, so
// each rich text block keeps to the 3000 characters a section allows.
const HEADER_LIMIT = 150;
const BLOCK_TEXT_LIMIT = 3000;
const BUTTON_LABEL_LIMIT = 75;
const URL_LIMIT = 3000;
// Mobile notifications show only the top-level text, so it stays one short line.
const FALLBACK_LIMIT = 300;
const POINT_LIMIT = 500;
const READING_LIMIT = 400;

const ORDER: readonly PointCategory[] = ["breaking", "new", "change", "fix"];

export interface SlackPlainText {
  readonly type: "plain_text";
  readonly text: string;
  readonly emoji: true;
}

export interface SlackButton {
  readonly type: "button";
  readonly action_id: string;
  readonly text: SlackPlainText;
  readonly url: string;
  readonly style?: "primary";
}

// Rich text is never parsed: a model-written backtick, `*`, `<!here>`, or `#channel` stays
// literal, and code is a style flag rather than markup.
export interface SlackRichText {
  readonly type: "text";
  readonly text: string;
  readonly style?: { readonly bold?: true; readonly code?: true };
}

// Only program-owned copy (group labels) is written as mrkdwn, escaped and verbatim.
export interface SlackMrkdwn {
  readonly type: "mrkdwn";
  readonly text: string;
  readonly verbatim: true;
}

// A Slack emoji by name, chosen by the program; model text never names one.
export interface SlackRichEmoji {
  readonly type: "emoji";
  readonly name: string;
}

export type SlackRichElement = SlackRichText | SlackRichEmoji;

export interface SlackRichSection {
  readonly type: "rich_text_section";
  readonly elements: readonly SlackRichElement[];
}

export interface SlackRichQuote {
  readonly type: "rich_text_quote";
  readonly elements: readonly SlackRichElement[];
}

export interface SlackRichList {
  readonly type: "rich_text_list";
  readonly style: "bullet";
  readonly indent: 0 | 1;
  readonly elements: readonly SlackRichSection[];
}

export type SlackBlock =
  | { readonly type: "header"; readonly text: SlackPlainText }
  | { readonly type: "context"; readonly elements: readonly SlackPlainText[] }
  | {
      readonly type: "rich_text";
      readonly elements: readonly (SlackRichSection | SlackRichList | SlackRichQuote)[];
    }
  | { readonly type: "section"; readonly text: SlackMrkdwn }
  | { readonly type: "divider" }
  | { readonly type: "actions"; readonly elements: readonly SlackButton[] };

export interface SlackMessage {
  readonly text: string;
  readonly blocks: readonly SlackBlock[];
}

// Kind marks: a release card and a discussion card tell themselves apart before a word is read.
const KIND_MARK = { changelog: "📦", hn: "🔥" } as const;

// Title, then the kind and source, then the summary as a quoted TL;DR; a divider; per point
// group a bold section label over a rich text bullet list, every reading nested under its
// point; another divider; then the link buttons. That is at most sixteen blocks, well under
// Slack's fifty.
export function renderSlack(doc: AlertDoc): SlackMessage {
  const rawTitle = doc.title.translated ?? doc.title.original;
  const title = clip(plainText(withoutCodeMarks(rawTitle)), HEADER_LIMIT);
  const detail = buttonUrl(doc.links.detail);
  if (detail === null || title === "") throw new AppError("CONTENT_UNSUPPORTED");
  const delivery = getLocale(doc.lang).delivery;

  const blocks: SlackBlock[] = [{ type: "header", text: plain(title) }];
  const source = clip(plainText(doc.source_label), BLOCK_TEXT_LIMIT - 4);
  if (source !== "") {
    blocks.push({ type: "context", elements: [plain(`${KIND_MARK[doc.item_kind]}  ${source}`)] });
  }

  const summaryKey = plainText(doc.summary).toLowerCase();
  if (summaryKey !== "" && summaryKey !== plainText(rawTitle).toLowerCase()) {
    const summary = richText(doc.summary, BLOCK_TEXT_LIMIT);
    if (summary.length > 0) {
      blocks.push({
        type: "rich_text",
        elements: [{ type: "rich_text_quote", elements: summary }],
      });
    }
  }

  // Quote-only points back the readable ones on the desk; a card never shows them.
  const readable = doc.key_points.filter((point) => point.evidence_quote === null);
  const labelled: [string, AlertPoint[]][] = ORDER.map((category) => [
    delivery.groupLabels[category],
    readable.filter((point) => point.category === category),
  ]);
  labelled.push([delivery.pointsLabel, readable.filter((point) => point.category === null)]);
  const groups: SlackBlock[] = [];
  for (const [label, points] of labelled) {
    const group = groupBlocks(label, points, delivery.readingLabel);
    if (group !== null) groups.push(...group);
  }
  if (groups.length > 0) blocks.push({ type: "divider" }, ...groups, { type: "divider" });

  const buttons: SlackButton[] = [
    button("detail", `📖 ${delivery.detailButtonLabel}`, detail, "primary"),
  ];
  const sourceUrl = buttonUrl(doc.links.source);
  if (sourceUrl !== null) {
    buttons.push(button("source", `🔗 ${delivery.sourceButtonLabel}`, sourceUrl));
  }
  const discussion = buttonUrl(doc.links.discussion);
  if (discussion !== null) {
    buttons.push(button("discussion", `💬 ${delivery.discussionButtonLabel}`, discussion));
  }
  blocks.push({ type: "actions", elements: buttons });

  // The top-level text is parsed as mrkdwn wherever Slack shows it (notifications,
  // clients without blocks), so it is escaped and carries no links.
  const fallback = [doc.source_label, withoutCodeMarks(rawTitle)]
    .map(plainText)
    .filter((part) => part !== "")
    .join(" · ");
  return { text: escape(unlinked(clip(fallback, FALLBACK_LIMIT))), blocks };
}

// A point and its reading go in together or not at all, so a group that runs out of
// room never shows a point stripped of its reading. Readings sit one level in behind a
// bulb, so the points read as the list and the readings as asides.
function groupBlocks(
  label: string,
  points: readonly AlertPoint[],
  readingLabel: string,
): readonly [SlackBlock, SlackBlock] | null {
  const lists: SlackRichList[] = [];
  let budget = BLOCK_TEXT_LIMIT;
  for (const point of points) {
    const text = richText(point.text, POINT_LIMIT);
    if (text.length === 0) continue;
    const entry: [0 | 1, SlackRichElement[]][] = [[0, text]];
    if (point.implication !== null) {
      const reading = richText(point.implication, READING_LIMIT);
      if (reading.length > 0) {
        entry.push([
          1,
          [{ type: "emoji", name: "bulb" }, { type: "text", text: ` ${readingLabel}` }, ...reading],
        ]);
      }
    }
    const cost = entry.reduce((total, [, pieces]) => total + textLength(pieces), 0);
    if (cost > budget) break;
    budget -= cost;
    for (const [indent, pieces] of entry) {
      const item: SlackRichSection = { type: "rich_text_section", elements: pieces };
      const last = lists.at(-1);
      if (last?.indent === indent) {
        lists[lists.length - 1] = { ...last, elements: [...last.elements, item] };
      } else {
        lists.push({ type: "rich_text_list", style: "bullet", indent, elements: [item] });
      }
    }
  }
  if (lists.length === 0) return null;
  // The label is locale copy, never model text. A section block carries the padding that
  // separates groups; rich text drops leading blank lines, so it cannot.
  return [
    { type: "section", text: { type: "mrkdwn", text: `*${escape(label)}*`, verbatim: true } },
    { type: "rich_text", elements: lists },
  ];
}

// Model text as rich text pieces: balanced backtick pairs become code-styled pieces and
// everything else stays literal. Slack refuses an empty piece, so none is emitted, and
// text past the limit is cut with an ellipsis.
function richText(input: string, limit: number): SlackRichText[] {
  const text = unlinked(plainText(input));
  const pieces: SlackRichText[] = [];
  let room = limit;
  const add = (part: string, code: boolean): boolean => {
    if (part === "") return true;
    const fits = part.length < room;
    const shown = fits ? part : withoutBrokenPair(part.slice(0, room - 1)).trimEnd();
    if (shown !== "") {
      pieces.push(
        code ? { type: "text", text: shown, style: { code: true } } : { type: "text", text: shown },
      );
    }
    room -= shown.length;
    if (!fits) pieces.push({ type: "text", text: "…" });
    return fits;
  };
  let cursor = 0;
  for (const span of text.matchAll(CODE_SPAN)) {
    if (!add(text.slice(cursor, span.index), false)) return pieces;
    if (!add(span[1] ?? "", true)) return pieces;
    cursor = span.index + span[0].length;
  }
  add(text.slice(cursor), false);
  return pieces;
}

function textLength(pieces: readonly SlackRichElement[]): number {
  return pieces.reduce(
    (total, piece) => total + (piece.type === "text" ? piece.text.length : piece.name.length + 2),
    0,
  );
}

// Plain-text objects are shown as written, so they are clipped but not escaped.
function plain(text: string): SlackPlainText {
  return { type: "plain_text", text, emoji: true };
}

function button(id: string, label: string, url: string, style?: "primary"): SlackButton {
  return {
    type: "button",
    action_id: id,
    text: plain(clip(label, BUTTON_LABEL_LIMIT)),
    url,
    ...(style === undefined ? {} : { style }),
  };
}

function buttonUrl(input: string | null): string | null {
  const url = publicLink(input);
  return url === null || url.length > URL_LIMIT ? null : url;
}

function escape(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function clip(input: string, limit: number): string {
  if (input.length <= limit) return input;
  return `${withoutBrokenPair(input.slice(0, limit - 1)).trimEnd()}…`;
}

// Cutting between the two halves of a surrogate pair would leave an invalid string.
function withoutBrokenPair(input: string): string {
  return /[\uD800-\uDBFF]$/u.test(input) ? input.slice(0, -1) : input;
}

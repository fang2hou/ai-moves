import type { AlertDoc, AlertPoint } from "@ai-moves/contracts/alert-doc";
import type { PointCategory } from "@ai-moves/contracts/analysis";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { publicLink } from "@ai-moves/kernel/public-links";
import { getLocale } from "@ai-moves/locales/registry";

import { CODE_SPAN, plainText, unlinked, withoutCodeMarks } from "./markup.ts";

// Block Kit limits: 150 characters in a header, 3000 in a section's text, 75 in a
// button label, and 3000 in a button URL.
const HEADER_LIMIT = 150;
const SECTION_LIMIT = 3000;
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

export interface SlackMrkdwn {
  readonly type: "mrkdwn";
  readonly text: string;
}

export interface SlackButton {
  readonly type: "button";
  readonly action_id: string;
  readonly text: SlackPlainText;
  readonly url: string;
  readonly style?: "primary";
}

export type SlackBlock =
  | { readonly type: "header"; readonly text: SlackPlainText }
  | { readonly type: "section"; readonly text: SlackMrkdwn }
  | { readonly type: "context"; readonly elements: readonly SlackMrkdwn[] }
  | { readonly type: "actions"; readonly elements: readonly SlackButton[] };

export interface SlackMessage {
  readonly text: string;
  readonly blocks: readonly SlackBlock[];
}

// The layout is bounded by construction: a header, the source, the summary, one
// section per point group plus one for ungrouped points, and the link buttons. That
// is at most nine blocks, well under Slack's fifty.
export function renderSlack(doc: AlertDoc): SlackMessage {
  const rawTitle = doc.title.translated ?? doc.title.original;
  const title = clip(plainText(withoutCodeMarks(rawTitle)), HEADER_LIMIT);
  const detail = buttonUrl(doc.links.detail);
  if (detail === null || title === "") throw new AppError("CONTENT_UNSUPPORTED");
  const delivery = getLocale(doc.lang).delivery;

  const blocks: SlackBlock[] = [{ type: "header", text: plain(title) }];
  const source = mrkdwn(doc.source_label, SECTION_LIMIT);
  if (source !== "") blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: source }] });

  const summaryKey = plainText(doc.summary).toLowerCase();
  if (summaryKey !== "" && summaryKey !== plainText(rawTitle).toLowerCase()) {
    blocks.push(section(mrkdwn(doc.summary, SECTION_LIMIT)));
  }

  // Quote-only points back the readable ones on the desk; a card never shows them.
  const readable = doc.key_points.filter((point) => point.evidence_quote === null);
  for (const category of ORDER) {
    const group = readable.filter((point) => point.category === category);
    const text = groupText(delivery.groupLabels[category], group, delivery.readingLabel);
    if (text !== null) blocks.push(section(text));
  }
  const ungrouped = readable.filter((point) => point.category === null);
  const points = groupText(delivery.pointsLabel, ungrouped, delivery.readingLabel);
  if (points !== null) blocks.push(section(points));

  const buttons: SlackButton[] = [button("detail", delivery.detailButtonLabel, detail, "primary")];
  const sourceUrl = buttonUrl(doc.links.source);
  if (sourceUrl !== null) buttons.push(button("source", delivery.sourceButtonLabel, sourceUrl));
  const discussion = buttonUrl(doc.links.discussion);
  if (discussion !== null) {
    buttons.push(button("discussion", delivery.discussionButtonLabel, discussion));
  }
  blocks.push({ type: "actions", elements: buttons });

  const fallback = [doc.source_label, withoutCodeMarks(rawTitle)].map(plainText);
  return {
    text: mrkdwn(fallback.filter((part) => part !== "").join(" · "), FALLBACK_LIMIT),
    blocks,
  };
}

// A point and its reading go in together or not at all, so a group that runs out of
// room never shows a point stripped of its reading.
function groupText(
  label: string,
  points: readonly AlertPoint[],
  readingLabel: string,
): string | null {
  const heading = `*${escape(label)}*`;
  const lines: string[] = [];
  let budget = SECTION_LIMIT - heading.length;
  for (const point of points) {
    const text = mrkdwn(point.text, POINT_LIMIT);
    if (text === "") continue;
    const pair = [`• ${text}`];
    if (point.implication !== null) {
      const reading = mrkdwn(point.implication, READING_LIMIT);
      if (reading !== "") pair.push(`> ${escape(readingLabel)}${reading}`);
    }
    const cost = pair.reduce((total, line) => total + line.length + 1, 0);
    if (cost > budget) break;
    lines.push(...pair);
    budget -= cost;
  }
  return lines.length === 0 ? null : [heading, ...lines].join("\n");
}

function section(text: string): { readonly type: "section"; readonly text: SlackMrkdwn } {
  return { type: "section", text: { type: "mrkdwn", text } };
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

// Slack has no escape for its emphasis marks, so model text keeps them; only the three
// control characters are escaped, everywhere including inside code. A balanced backtick
// pair stays inline code, and a stray backtick becomes a look-alike so no run of them
// can open a code block.
function mrkdwn(input: string, limit: number): string {
  const text = unlinked(plainText(input));
  let output = "";
  let truncated = false;
  const append = (literal: string): void => {
    if (truncated) return;
    if (output.length + literal.length >= limit) {
      output = `${output.trimEnd()}…`;
      truncated = true;
      return;
    }
    output += literal;
  };
  const prose = (part: string): void => {
    for (const character of part) {
      append(character === "`" ? "ˋ" : escape(character));
    }
  };
  let cursor = 0;
  for (const span of text.matchAll(CODE_SPAN)) {
    prose(text.slice(cursor, span.index));
    append(`\`${escape(span[1] ?? "")}\``);
    cursor = span.index + span[0].length;
  }
  prose(text.slice(cursor));
  return output;
}

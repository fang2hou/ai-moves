import type { AlertDoc, AlertPoint } from "@ai-moves/contracts/alert-doc";
import type { PointCategory } from "@ai-moves/contracts/analysis";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { publicLink } from "@ai-moves/kernel/public-links";

import { brandOf } from "./brand.ts";

// Discord allows 4096 characters in an embed description and 1024 in a field value.
const DESCRIPTION_LIMIT = 2000;
const FIELD_LIMIT = 1000;
// It also allows 6000 characters in all the text of a message's embeds together: the
// title, description, field names and values, footer and author. Above that the card is
// rejected with a 400, which loses it for good, so it is cut to fit here. The margin
// leaves room for Discord counting differently.
const EMBED_TOTAL_BUDGET = 5900;

const SOURCE_LABEL: Record<AlertDoc["lang"], string> = {
  en: "🔗 Source",
  "zh-CN": "🔗 原文",
  ja: "🔗 原文",
};

// The address without its scheme, which is what a reader recognises.
function linkText(url: string): string {
  const parsed = URL.parse(url);
  if (parsed === null) return url.slice(0, 120);
  const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/u, "");
  return `${parsed.hostname}${path}`.slice(0, 120);
}

const POINTS_LABEL: Record<AlertDoc["lang"], string> = {
  en: "💬 What it says",
  "zh-CN": "💬 讲了什么",
  ja: "💬 内容",
};

const READING_LABEL: Record<AlertDoc["lang"], string> = {
  en: "AI insight: ",
  "zh-CN": "AI洞察：",
  ja: "AI考察：",
};

// The four groups a release breaks into, in the order a reader wants them: what
// stops working, what is new, what moved, what is fixed.
const ORDER: readonly PointCategory[] = ["breaking", "new", "change", "fix"];

const GROUP_LABEL: Record<AlertDoc["lang"], Record<PointCategory, string>> = {
  en: {
    breaking: "⚠️ Breaking",
    new: "✨ New",
    change: "🔀 Changed",
    fix: "🩹 Fixed",
  },
  "zh-CN": {
    breaking: "⚠️ 破坏性变更",
    new: "✨ 新增",
    change: "🔀 变更",
    fix: "🩹 修复",
  },
  ja: {
    breaking: "⚠️ 破壊的変更",
    new: "✨ 追加",
    change: "🔀 変更",
    fix: "🩹 修正",
  },
};

// Discord trims a trailing newline, so a blank line has to carry a character; a
// zero-width space is the one that shows nothing.
const GAP = "\n\u200b";

interface EmbedField {
  readonly name: string;
  readonly value: string;
}

interface Embed {
  readonly title: string;
  readonly url: string;
  readonly color: number;
  readonly timestamp: string;
  readonly author?: { readonly name: string; readonly icon_url?: string };
  readonly description?: string;
  readonly fields: readonly EmbedField[];
  readonly footer?: { readonly text: string };
}

export function renderDiscord(doc: AlertDoc): {
  readonly embeds: readonly [Embed];
  readonly allowed_mentions: { readonly parse: readonly never[] };
} {
  // Discord renders no markup in an embed title, so a code span there would show its
  // backticks.
  const title = embedText(withoutCodeMarks(doc.title.translated ?? doc.title.original), 256);
  // The title links to the desk page, which is where the source link and the rest
  // of the record live.
  const url = publicLink(doc.links.detail);
  if (url === null || title === "") throw new AppError("CONTENT_UNSUPPORTED");
  const brand = brandOf(doc, url);

  const author = embedText(doc.source_label, 256);
  // A reader who skipped the body scrolls to the bottom for the link, and a footer
  // renders as plain text. A field is the last thing in an embed that can hold a
  // clickable link, so the link is the final field.
  const source = publicLink(doc.links.source);
  const link =
    source !== null && !source.includes(")")
      ? { name: SOURCE_LABEL[doc.lang], value: `[${linkText(source)}](${source})` }
      : undefined;

  // The title and the link are what make the card useful, so they are never cut and the
  // body yields instead: the groups from the end, the summary last of all. Were the title
  // and the link to use up the budget on their own, the body would go out empty and the
  // card would still be over the limit. The source label is charged twice because it goes
  // out twice, as the author and as the footer.
  let total =
    title.length +
    2 * author.length +
    (link === undefined ? 0 : link.name.length + link.value.length);

  const seen = new Set([plainText(doc.title.translated ?? doc.title.original).toLowerCase()]);
  const summary = (() => {
    const key = plainText(doc.summary).toLowerCase();
    if (key === "" || seen.has(key)) return "";
    seen.add(key);
    const text = embedText(doc.summary, DESCRIPTION_LIMIT);
    // The gap that sets the summary apart from the first group goes out with it.
    return total + text.length + GAP.length <= EMBED_TOTAL_BUDGET ? text : "";
  })();
  total += summary === "" ? 0 : summary.length + GAP.length;

  // Points are grouped so the reader sees the shape of the release before reading a
  // word of it: a card with a Breaking field says more at a glance than six bullets.
  const grouped = new Map<PointCategory, AlertPoint[]>();
  for (const point of doc.key_points) {
    if (point.evidence_quote !== null || point.category === null) continue;
    const group = grouped.get(point.category);
    if (group === undefined) grouped.set(point.category, [point]);
    else group.push(point);
  }

  // The groups in that order, the ones with no category last.
  const groups: { readonly name: string; readonly points: readonly AlertPoint[] }[] = [];
  for (const category of ORDER) {
    const group = grouped.get(category);
    if (group !== undefined) groups.push({ name: GROUP_LABEL[doc.lang][category], points: group });
  }
  // A discussion has no releases to group, so its points stay one list.
  const ungrouped = doc.key_points.filter(
    (point) => point.evidence_quote === null && point.category === null,
  );
  if (ungrouped.length > 0) groups.push({ name: POINTS_LABEL[doc.lang], points: ungrouped });

  const fields: EmbedField[] = [];
  for (const { name, points } of groups) {
    const value = groupValue(points, doc.lang, FIELD_LIMIT);
    // A group whose points all came out empty has no field.
    if (value === "") continue;
    // The gap is reserved because this field may end up last, above the link.
    if (total + name.length + value.length + GAP.length > EMBED_TOTAL_BUDGET) {
      // The first group the budget cannot hold ends the body. It stays with the points
      // that fit, cut after a whole point, and no group after it is tried: one cut at the
      // end is easier to read than a card that skips a group and carries on.
      const kept = groupValue(
        points,
        doc.lang,
        EMBED_TOTAL_BUDGET - total - name.length - GAP.length,
      );
      if (kept !== "") fields.push({ name, value: kept });
      break;
    }
    fields.push({ name, value });
    total += name.length + value.length;
  }

  if (link !== undefined) {
    const last = fields.at(-1);
    // One blank line sets the link apart from the last point. A whole spacer field
    // leaves too much air, so the gap is a trailing line on the field above it.
    if (last !== undefined) fields[fields.length - 1] = { ...last, value: `${last.value}${GAP}` };
    fields.push(link);
  }
  // The same single blank line separates the summary from the first group.
  const description = summary === "" || fields.length === 0 ? summary : `${summary}${GAP}`;
  return {
    embeds: [
      {
        title,
        url,
        color: brand.color,
        timestamp: new Date(doc.generated_at).toISOString(),
        ...(author === ""
          ? {}
          : { author: { name: author, ...(brand.icon === null ? {} : { icon_url: brand.icon }) } }),
        ...(description === "" ? {} : { description }),
        fields,
        ...(author === "" ? {} : { footer: { text: author } }),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

// One group's points, each on its own line with its reading as Discord subtext
// beneath it, which renders smaller and dimmed.
function groupValue(points: readonly AlertPoint[], lang: AlertDoc["lang"], limit: number): string {
  const lines: string[] = [];
  let budget = limit;
  for (const point of points) {
    const text = embedText(point.text, 500);
    if (text === "") continue;
    // A point and its reading go in together or not at all. Measured line by line,
    // a group that runs out of room drops the reading and keeps the point, which
    // reads as though the model had nothing to say about that one.
    const pair = [`- ${text}`];
    if (point.implication !== null) {
      pair.push(`-# ${READING_LABEL[lang]}${embedText(point.implication, 400)}`);
    }
    const cost = pair.reduce((total, line) => total + line.length + 1, 0);
    if (cost > budget) break;
    lines.push(...pair);
    budget -= cost;
  }
  return lines.join("\n");
}

function withoutCodeMarks(input: string): string {
  return input.replace(/`([^`\n]{1,200})`/gu, "$1");
}

function plainText(input: string): string {
  return input
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, "")
    .trim();
}

// Inline code is the one piece of markup the writing allows, and Discord renders it,
// so a balanced backtick pair is passed through with its contents untouched. Outside
// such a pair every markup character is escaped, backticks included, so a stray run
// can never open a code fence.
const CODE_SPAN = /`([^`\n]{1,200})`/gu;

function embedText(input: string, limit: number): string {
  const text = plainText(input)
    .replace(/https?:\/\/|www\./giu, (prefix) => `${prefix[0]}​${prefix.slice(1)}`)
    .replace(/^([-+]|\d+\.)(?= )/u, (marker) => `${marker}​`);
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
  const escape = (plain: string): void => {
    for (const character of plain) {
      append(
        character === "@" ? "@​" : /[\\*_~`|[\]<>#]/u.test(character) ? `\\${character}` : character,
      );
    }
  };
  let cursor = 0;
  for (const span of text.matchAll(CODE_SPAN)) {
    escape(text.slice(cursor, span.index));
    append(`\`${span[1] ?? ""}\``);
    cursor = span.index + span[0].length;
  }
  escape(text.slice(cursor));
  return output;
}

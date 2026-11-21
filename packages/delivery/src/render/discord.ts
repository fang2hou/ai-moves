import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { publicLink } from "@ai-moves/kernel/public-links";

interface EmbedField {
  readonly name: string;
  readonly value: string;
}

export function renderDiscord(doc: AlertDoc): {
  readonly embeds: readonly [
    {
      readonly title: string;
      readonly url: string;
      readonly description?: string;
      readonly fields: readonly EmbedField[];
      readonly footer?: { readonly text: string };
    },
  ];
  readonly allowed_mentions: { readonly parse: readonly never[] };
} {
  const title = embedText(doc.title.translated ?? doc.title.original, 256);
  const url = publicLink(doc.links.source);
  if (url === null || title === "") throw new AppError("CONTENT_UNSUPPORTED");

  const fields: EmbedField[] = [];
  const seen = new Set([plainText(doc.title.translated ?? doc.title.original).toLowerCase()]);
  function distinct(input: string, limit: number): string {
    const key = plainText(input).toLowerCase();
    if (key === "" || seen.has(key)) return "";
    seen.add(key);
    return embedText(input, limit);
  }

  // The fixed field count and compact budgets keep the whole embed below 6,000 characters.
  const description = distinct(doc.why_now, 500);
  if (doc.item_kind === "changelog") {
    for (const implication of doc.engineering_implications) {
      const value = distinct(implication, 500);
      if (value === "") continue;
      fields.push({ name: "Engineering impact", value });
      break;
    }
  }
  for (const { evidence_quote, comment_id } of doc.key_points) {
    if (evidence_quote === null) continue;
    const value = distinct(evidence_quote, 350);
    if (value === "") continue;
    fields.push({
      name: doc.item_kind === "hn" && comment_id !== null ? "HN comment" : "Source quote",
      value,
    });
    break;
  }
  const source = embedText(doc.source_label, 128);
  return {
    embeds: [
      {
        title,
        url,
        ...(description === "" ? {} : { description }),
        fields,
        ...(source === "" ? {} : { footer: { text: source } }),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function plainText(input: string): string {
  return input
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, "")
    .trim();
}

function embedText(input: string, limit: number): string {
  const text = plainText(input)
    .replace(/https?:\/\/|www\./giu, (prefix) => `${prefix[0]}\u200B${prefix.slice(1)}`)
    .replace(/^([-+]|\d+\.)(?= )/u, (marker) => `${marker}\u200B`);
  let output = "";
  for (const character of text) {
    const literal =
      character === "@"
        ? "@\u200B"
        : /[\\*_~`|[\]<>#]/u.test(character)
          ? `\\${character}`
          : character;
    if (output.length + literal.length >= limit) return `${output.trimEnd()}…`;
    output += literal;
  }
  return output;
}

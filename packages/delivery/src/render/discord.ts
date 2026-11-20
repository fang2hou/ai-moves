import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import { renderText } from "./text.ts";

export function renderDiscord(doc: AlertDoc): {
  readonly content: string;
  readonly allowed_mentions: { readonly parse: readonly never[] };
} {
  const text = renderText(doc);
  if (doc.links.detail.length >= 2000) throw new AppError("CONTENT_UNSUPPORTED");
  const available = 1999 - doc.links.detail.length;
  let prefix = text.slice(0, available);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  const content = text.length <= 2000 ? text : `${prefix}\n${doc.links.detail}`;
  return { content, allowed_mentions: { parse: [] } };
}

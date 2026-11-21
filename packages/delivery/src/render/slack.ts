import type { AlertDoc } from "@ai-moves/contracts/alert-doc";

import { renderText } from "./text.ts";

function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderSlack(doc: AlertDoc): { readonly text: string; readonly mrkdwn: false } {
  return { text: escapeText(renderText(doc)), mrkdwn: false };
}

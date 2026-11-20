import type { AlertDoc } from "@ai-moves/contracts/alert-doc";

export function renderText(doc: AlertDoc): string {
  return [
    `${doc.source_label} · Tier ${doc.tier} · ${doc.kind}`,
    doc.title.translated ?? doc.title.original,
    ...(doc.title.translated === null ? [] : [doc.title.original]),
    doc.why_now,
    doc.summary,
    ...doc.key_points.flatMap((point) => [
      `• ${point.text}`,
      ...(point.evidence_quote === null ? [] : [`  “${point.evidence_quote}”`]),
      ...(point.comment_id === null ? [] : [`  Comment: ${point.comment_id}`]),
    ]),
    ...doc.engineering_implications.map((point) => `• ${point}`),
    ...doc.caveats.map((point) => `• ${point}`),
    ...(doc.translation.machine_translated ? ["Machine translated"] : []),
    ...(doc.translation.fell_back_to_english ? ["English fallback"] : []),
    doc.links.source,
    ...(doc.links.discussion === null ? [] : [doc.links.discussion]),
    doc.links.detail,
  ].join("\n");
}

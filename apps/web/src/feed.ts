import type { Lang } from "@ai-moves/contracts/primitives";

import type { AlertDetail, FeedAlert, FeedItem } from "./api.ts";
import { dateLabel, deskUrl, element, humanize, link } from "./dom.ts";

const languageNames = { en: "English", "zh-CN": "Simplified Chinese", ja: "Japanese" } as const;
const itemKind = { hn: "Hacker News", changelog: "Changelog" };

function nextPage(next: string | null, path: string): HTMLElement {
  return element(
    "div",
    { class: "pagination" },
    ...(next === null
      ? []
      : [link("Older entries", deskUrl(path, { before: next }), "button secondary")]),
  );
}

export function feedView(
  items: readonly FeedItem[],
  next: string | null,
  older: boolean,
): HTMLElement {
  return element(
    "section",
    {},
    element(
      "div",
      { class: "hero" },
      element(
        "div",
        { class: "hero-copy" },
        element("h1", {}, "Signal desk"),
        element("p", {}, "Track releases and discussions shaping how AI software gets built."),
      ),
      element(
        "div",
        { class: "signal", "aria-hidden": "true" },
        element("span"),
        element("span"),
        element("span"),
      ),
    ),
    element(
      "div",
      { class: "section-heading" },
      element("h2", {}, older ? "Older signals" : "Latest signals"),
      ...(older ? [link("Back to latest", "/")] : [element("span", {}, "Newest first · UTC")]),
    ),
    items.length === 0
      ? element(
          "p",
          { class: "notice" },
          older ? "There are no older signals." : "No signals have reached the feed yet.",
        )
      : element(
          "ul",
          { class: "ledger" },
          ...items.map((item) =>
            element(
              "li",
              { class: "ledger-row" },
              dateLabel(item.first_seen_at),
              element(
                "div",
                {},
                element("span", { class: "source" }, itemKind[item.kind]),
                link(item.title, `/items/${item.id}`, "entry"),
              ),
              element("span", { class: "tag" }, item.state === "alerted" ? "Alerted" : "Feed only"),
            ),
          ),
        ),
    nextPage(next, "/"),
  );
}

export function itemView(
  item: FeedItem,
  alerts: readonly FeedAlert[],
  next: string | null,
): HTMLElement {
  return element(
    "article",
    { class: "reading" },
    link("Back to feed", "/"),
    element(
      "header",
      { class: "reading-header" },
      element("p", { class: "source" }, itemKind[item.kind], " • ", dateLabel(item.first_seen_at)),
      element("h1", {}, item.title),
      ...(item.url === null ? [] : [link("Open original source", item.url, "button secondary")]),
    ),
    element("h2", {}, "Alert history"),
    alerts.length === 0
      ? element("p", { class: "notice" }, "No alerts on this page.")
      : element(
          "ul",
          { class: "ledger" },
          ...alerts.map((alert) =>
            element(
              "li",
              { class: "ledger-row" },
              dateLabel(alert.created_at),
              link(
                alert.kind === "new" ? "Initial alert" : "Alert update",
                `/alerts/${alert.id}`,
                "entry",
              ),
              element("span", { class: "tag" }, `Tier ${alert.tier}`),
            ),
          ),
        ),
    nextPage(next, `/items/${item.id}`),
  );
}

function textList(heading: string, entries: (string | HTMLElement)[]): HTMLElement {
  return element(
    "section",
    {},
    element("h2", {}, heading),
    element("ul", { class: "points" }, ...entries.map((entry) => element("li", {}, entry))),
  );
}

export function alertView(detail: AlertDetail, lang: Lang): HTMLElement {
  const { alert, document, deliveries } = detail;
  const displayTitle = document?.title.translated ?? document?.title.original ?? "Alert details";
  return element(
    "article",
    { class: "reading" },
    link("Back to signal", `/items/${alert.item_id}`),
    element(
      "header",
      { class: "reading-header" },
      element("p", { class: "source" }, `Tier ${alert.tier} • `, dateLabel(alert.created_at)),
      element("h1", {}, displayTitle),
      element(
        "nav",
        { "aria-label": "Alert language", class: "languages" },
        ...Object.entries(languageNames).map(([key, name]) =>
          element(
            "a",
            {
              href: deskUrl(`/alerts/${alert.id}`, { lang: key }),
              ...(key === lang ? { "aria-current": "page" } : {}),
            },
            name,
          ),
        ),
      ),
    ),
    ...(document === null
      ? [element("p", { class: "notice" }, "No alert document is available in this language.")]
      : [
          element("p", { class: "source" }, document.source_label),
          ...(document.translation.fell_back_to_english
            ? [element("p", { class: "notice" }, "Showing the original English document.")]
            : []),
          element("p", { class: "lede" }, document.summary),
          element("h2", {}, "Why now"),
          element("p", {}, document.why_now),
          ...(document.key_points.length === 0
            ? []
            : [
                textList(
                  "Key points",
                  document.key_points.map((point) =>
                    element(
                      "div",
                      {},
                      point.text,
                      ...(point.evidence_quote === null
                        ? []
                        : [element("blockquote", {}, point.evidence_quote)]),
                    ),
                  ),
                ),
              ]),
          ...(document.engineering_implications.length === 0
            ? []
            : [textList("Engineering implications", document.engineering_implications)]),
          ...(document.caveats.length === 0 ? [] : [textList("Caveats", document.caveats)]),
          element(
            "div",
            { class: "languages" },
            link("Original source", document.links.source),
            ...(document.links.discussion === null
              ? []
              : [link("Discussion", document.links.discussion)]),
          ),
        ]),
    element("h2", {}, "Delivery status"),
    deliveries.length === 0
      ? element("p", { class: "notice" }, "No deliveries were recorded.")
      : textList(
          "Outcomes",
          deliveries.map(
            (delivery) =>
              `${delivery.destination_id}: ${humanize(delivery.state)}${delivery.dry_run ? " (dry run)" : ""}${delivery.suppressed_reason === null ? "" : ` — ${humanize(delivery.suppressed_reason)}`}`,
          ),
        ),
  );
}

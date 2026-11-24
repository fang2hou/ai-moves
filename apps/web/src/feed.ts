import type { AlertPoint } from "@ai-moves/contracts/alert-doc";
import type { Lang } from "@ai-moves/contracts/primitives";
import { publicLink } from "@ai-moves/kernel/public-links";
import type { LocalePack } from "@ai-moves/locales/types";

import type { AlertDetail, FeedItem } from "./api.ts";
import { dateLabel, deskUrl, element, link, rich } from "./dom.ts";
import { sourceMark, sourceName } from "./source.ts";

export function feedView(
  items: readonly FeedItem[],
  next: string | null,
  older: boolean,
  locale: LocalePack,
): HTMLElement {
  const { desk } = locale;
  const body =
    items.length === 0
      ? element("p", { class: "notice" }, older ? desk.noOlderItems : desk.noItemsYet)
      : element(
          "ul",
          { class: "index" },
          ...items.map((item) =>
            element(
              "li",
              {},
              element(
                "span",
                { class: "origin" },
                sourceMark(item.kind, item.url),
                element("span", { class: "origin-name" }, sourceName(item.kind, item.url)),
                dateLabel(item.first_seen_at, locale.dateLocale),
              ),
              element("a", { href: deskUrl(`/items/${item.id}`) }, ...rich(item.title)),
            ),
          ),
        );
  return element(
    "section",
    {},
    body,
    ...(next === null
      ? []
      : [
          element(
            "div",
            { class: "pagination" },
            link(desk.olderItems, deskUrl("/", { before: next })),
          ),
        ]),
  );
}

function section(heading: string, lang: Lang, ...children: (Node | string)[]): HTMLElement {
  return element("section", {}, element("h2", { lang }, heading), ...children);
}

function subsection(heading: string, lang: Lang, ...children: (Node | string)[]): HTMLElement {
  return element("div", { class: "sub" }, element("h3", { lang }, heading), ...children);
}

function list(entries: readonly string[]): HTMLElement {
  return element("ul", {}, ...entries.map((entry) => element("li", {}, ...rich(entry))));
}

// The consequence is the model's reading rather than anything the source says, so it
// sits under the change on a line of its own and is labelled as a reading.
function pointItem(
  { category, text, implication }: AlertPoint,
  { desk, lang }: LocalePack,
): HTMLElement {
  return element(
    "li",
    { class: category === null ? "point" : `point point-${category}` },
    ...(category === null
      ? []
      : [element("span", { class: "cat", lang }, desk.categories[category])]),
    element("span", {}, ...rich(text)),
    ...(implication === null
      ? []
      : [
          element(
            "p",
            { class: "implication" },
            element("span", { class: "tag", lang }, desk.aiInsightTag),
            ...rich(implication),
          ),
        ]),
  );
}

export function alertView(
  detail: AlertDetail | { readonly document: null },
  locale: LocalePack,
  item?: FeedItem,
): HTMLElement {
  const { desk, lang } = locale;
  const { document } = detail;
  const back = link(desk.backHome, deskUrl("/"), "back");
  back.lang = lang;
  if (document === null) {
    const source = item === undefined ? null : publicLink(item.url);
    return element(
      "article",
      { class: "article" },
      back,
      ...(item === undefined || source === null
        ? [element("p", { class: "notice" }, desk.noDocument)]
        : [
            element("h1", {}, ...rich(item.title)),
            element("div", { class: "sources" }, link(desk.readSource, source)),
          ]),
    );
  }

  // A point carrying a quote is the verbatim evidence behind the reading. It is kept
  // with the document as its audit trail and as the record of which comments have
  // been read, but the page is a preview and shows only the points themselves.
  const plain = document.key_points.filter((point) => point.evidence_quote === null);
  // Only a Hacker News story carries a discussion link.
  const kind = document.links.discussion === null ? "changelog" : "hn";
  const date = dateLabel(detail.alert.created_at, locale.dateLocale);
  date.lang = lang;

  return element(
    "article",
    { class: "article", lang: document.lang },
    back,
    element(
      "p",
      { class: "origin" },
      sourceMark(kind, document.links.source),
      element("span", { class: "origin-name" }, document.source_label),
      date,
    ),
    element("h1", {}, ...rich(document.title.translated ?? document.title.original)),
    ...(document.title.translated === null
      ? []
      : [element("p", { class: "original" }, ...rich(document.title.original))]),
    element("p", { class: "lede" }, ...rich(document.summary)),
    ...(plain.length === 0
      ? []
      : [
          section(
            desk.pointsHeading,
            lang,
            element("ul", {}, ...plain.map((entry) => pointItem(entry, locale))),
          ),
        ]),
    ...(document.community_view === null
      ? []
      : [
          section(
            desk.communityHeading,
            lang,
            element("p", { class: "mood", lang }, desk.moods[document.community_view.overall]),
            element("p", {}, ...rich(document.community_view.summary)),
            ...(document.community_view.supporting.length === 0
              ? []
              : [
                  subsection(
                    desk.supportingHeading,
                    lang,
                    list(document.community_view.supporting),
                  ),
                ]),
            ...(document.community_view.opposing.length === 0
              ? []
              : [subsection(desk.opposingHeading, lang, list(document.community_view.opposing))]),
          ),
        ]),
    element(
      "div",
      { class: "sources", lang },
      link(desk.readSource, document.links.source),
      ...(document.links.discussion === null
        ? []
        : [link(desk.hnDiscussion, document.links.discussion)]),
    ),
  );
}

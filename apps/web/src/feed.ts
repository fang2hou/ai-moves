import type { AlertDetail, FeedItem } from "./api.ts";
import { dateLabel, deskUrl, element, link, rich } from "./dom.ts";
import { sourceMark, sourceName } from "./source.ts";

const moodName = {
  positive: "整体正面",
  mixed: "评价分化",
  negative: "整体负面",
  unclear: "看法不明",
} as const;

function pagination(next: string | null, path: string): HTMLElement | null {
  if (next === null) return null;
  return element(
    "div",
    { class: "pagination" },
    link("更早的条目", deskUrl(path, { before: next })),
  );
}

export function feedView(
  items: readonly FeedItem[],
  next: string | null,
  older: boolean,
): HTMLElement {
  const body =
    items.length === 0
      ? element("p", { class: "notice" }, older ? "没有更早的条目了。" : "还没有条目进入这里。")
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
                dateLabel(item.first_seen_at),
              ),
              element("a", { href: `/items/${item.id}` }, ...rich(item.title)),
            ),
          ),
        );
  const more = pagination(next, "/");
  return element("section", {}, body, ...(more === null ? [] : [more]));
}

function section(heading: string, ...children: (Node | string)[]): HTMLElement {
  return element("section", {}, element("h2", {}, heading), ...children);
}

function subsection(heading: string, ...children: (Node | string)[]): HTMLElement {
  return element("div", { class: "sub" }, element("h3", {}, heading), ...children);
}

function list(entries: readonly string[]): HTMLElement {
  return element("ul", {}, ...entries.map((entry) => element("li", {}, ...rich(entry))));
}

// What kind of change a point reports, shown as a chip so the shape of a release
// reads before the words do.
const categoryName = {
  breaking: "破坏性",
  new: "新增",
  change: "变更",
  fix: "修复",
} as const;

type Category = keyof typeof categoryName;

// The consequence is the model's reading rather than anything the source says, so it
// sits under the change on a line of its own and is labelled as a reading.
function pointItem(
  category: Category | null,
  text: string,
  implication: string | null,
): HTMLElement {
  return element(
    "li",
    { class: category === null ? "point" : `point point-${category}` },
    ...(category === null ? [] : [element("span", { class: "cat" }, categoryName[category])]),
    element("span", {}, ...rich(text)),
    ...(implication === null
      ? []
      : [
          element(
            "p",
            { class: "implication" },
            element("span", { class: "tag" }, "AI洞察"),
            ...rich(implication),
          ),
        ]),
  );
}

export function alertView(detail: AlertDetail): HTMLElement {
  const { alert, document } = detail;
  if (document === null) {
    return element(
      "article",
      { class: "article" },
      link("返回首页", "/", "back"),
      element("p", { class: "notice" }, "这条还没有可读的内容。"),
    );
  }

  // A point carrying a quote is the verbatim evidence behind the reading. It is kept
  // with the document as its audit trail and as the record of which comments have
  // been read, but the page is a preview and shows only the points themselves.
  const plain = document.key_points.filter((point) => point.evidence_quote === null);
  // Only a Hacker News story carries a discussion link.
  const kind = document.links.discussion === null ? "changelog" : "hn";

  return element(
    "article",
    { class: "article" },
    link("返回首页", "/", "back"),
    element(
      "p",
      { class: "origin" },
      sourceMark(kind, document.links.source),
      element("span", { class: "origin-name" }, document.source_label),
      dateLabel(alert.created_at),
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
            "要点",
            element(
              "ul",
              {},
              ...plain.map((entry) => pointItem(entry.category, entry.text, entry.implication)),
            ),
          ),
        ]),
    ...(document.community_view === null
      ? []
      : [
          section(
            "社区怎么看",
            element("p", { class: "mood" }, moodName[document.community_view.overall]),
            element("p", {}, ...rich(document.community_view.summary)),
            ...(document.community_view.supporting.length === 0
              ? []
              : [subsection("支持的声音", list([...document.community_view.supporting]))]),
            ...(document.community_view.opposing.length === 0
              ? []
              : [subsection("反对的声音", list([...document.community_view.opposing]))]),
          ),
        ]),
    element(
      "div",
      { class: "sources" },
      link("阅读原文", document.links.source),
      ...(document.links.discussion === null
        ? []
        : [link("Hacker News 讨论", document.links.discussion)]),
    ),
  );
}

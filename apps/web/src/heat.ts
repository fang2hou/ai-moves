import type { HeatLocale, HeatRange, LocalePack } from "@ai-moves/locales/types";

import type { HeatItem, HeatReport } from "./api.ts";
import { deskUrl, element, rich } from "./dom.ts";
import { sourceMark, sourceName } from "./source.ts";

export const HEAT_RANGES: readonly HeatRange[] = [7, 30];

export function readHeatRange(value: string | null): HeatRange {
  return HEAT_RANGES.find((range) => String(range) === value) ?? 30;
}

const DAY_MS = 86_400_000;
const TOP_SOURCES = 8;
const TOP_DISCUSSIONS = 8;
const SVG_NS = "http://www.w3.org/2000/svg";
// Days are counted on the same calendar as the dates the desk prints.
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" });

function svg(
  tag: string,
  attributes: Readonly<Record<string, string>>,
  ...children: (Node | string)[]
): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

interface Day {
  readonly key: string;
  readonly at: number;
  hn: number;
  changelog: number;
}

export function heatView(report: HeatReport, range: HeatRange, locale: LocalePack): HTMLElement {
  const copy = locale.desk.heat;
  // The API window is the trailing `range` days to the minute, so it touches `range + 1` calendar
  // days: the first and last are partial.
  const days: Day[] = Array.from({ length: range + 1 }, (_, index) => {
    const at = report.since + index * DAY_MS;
    return { key: dayKey.format(at), at, hn: 0, changelog: 0 };
  });
  const byKey = new Map(days.map((day) => [day.key, day]));
  const { items } = report;
  for (const item of items) {
    const day = byKey.get(dayKey.format(item.first_seen_at));
    if (day !== undefined) day[item.kind] += 1;
  }

  return element(
    "section",
    { class: "heat" },
    element("div", { class: "heat-head" }, element("h1", {}, copy.title), rangeSwitch(range, copy)),
    ...(items.length === 0
      ? [element("p", { class: "notice" }, copy.empty)]
      : [
          stats(items, copy),
          panel(copy.daily, dailyChart(days, copy, locale.dateLocale)),
          panel(copy.sources, sourceList(items)),
          ...hottest(items, copy),
        ]),
    ...(report.complete ? [] : [element("p", { class: "notice" }, copy.partial)]),
  );
}

function rangeSwitch(current: HeatRange, copy: HeatLocale): HTMLElement {
  return element(
    "nav",
    { class: "range", "aria-label": copy.title },
    ...HEAT_RANGES.map((range) =>
      element(
        "a",
        {
          href: deskUrl("/heat", { days: String(range) }),
          ...(range === current ? { "aria-current": "page" } : {}),
        },
        copy.ranges[range],
      ),
    ),
  );
}

function panel(heading: string, body: HTMLElement): HTMLElement {
  return element("section", { class: "panel" }, element("h2", {}, heading), body);
}

function stats(items: readonly HeatItem[], copy: HeatLocale): HTMLElement {
  const count = (keep: (item: HeatItem) => boolean): string => String(items.filter(keep).length);
  const entries: [string, string][] = [
    [copy.published, String(items.length)],
    [copy.discussions, count((item) => item.kind === "hn")],
    [copy.releases, count((item) => item.kind === "changelog")],
    [copy.peak, count((item) => item.tier === "H3")],
  ];
  return element(
    "dl",
    { class: "stats" },
    ...entries.map(([label, value]) =>
      element("div", {}, element("dt", {}, label), element("dd", {}, value)),
    ),
  );
}

// One column per day: releases at the base, discussions stacked on top. Drawn as SVG so
// the bars need no inline styles, which the desk's Content-Security-Policy forbids.
function dailyChart(days: readonly Day[], copy: HeatLocale, dateLocale: string): HTMLElement {
  const peak = Math.max(1, ...days.map((day) => day.hn + day.changelog));
  const height = 60;
  const short = (at: number): string =>
    new Date(at).toLocaleDateString(dateLocale, {
      month: "short",
      day: "numeric",
      timeZone: "Asia/Tokyo",
    });
  const columns = days.map((day, index) => {
    const base = (day.changelog / peak) * height;
    const top = (day.hn / peak) * height;
    return svg(
      "g",
      {},
      svg(
        "title",
        {},
        `${short(day.at)} · ${copy.discussions} ${day.hn} · ${copy.releases} ${day.changelog}`,
      ),
      svg("rect", { class: "bar-track", x: String(index * 10), y: "0", width: "8", height: "60" }),
      svg("rect", {
        class: "bar-changelog",
        x: String(index * 10),
        y: String(height - base),
        width: "8",
        height: String(base),
      }),
      svg("rect", {
        class: "bar-hn",
        x: String(index * 10),
        y: String(height - base - top),
        width: "8",
        height: String(top),
      }),
    );
  });
  const first = days[0];
  const last = days.at(-1);
  return element(
    "figure",
    { class: "chart" },
    svg(
      "svg",
      {
        viewBox: `0 0 ${days.length * 10 - 2} ${height}`,
        preserveAspectRatio: "none",
        role: "img",
        "aria-label": copy.daily,
      },
      ...columns,
    ),
    element(
      "figcaption",
      {},
      element("span", {}, first === undefined ? "" : short(first.at)),
      element(
        "span",
        { class: "legend" },
        element("span", { class: "key key-hn" }, copy.discussions),
        element("span", { class: "key key-changelog" }, copy.releases),
      ),
      element("span", {}, last === undefined ? "" : short(last.at)),
    ),
  );
}

function sourceList(items: readonly HeatItem[]): HTMLElement {
  const groups = new Map<string, { readonly sample: HeatItem; count: number }>();
  for (const item of items) {
    const name = sourceName(item.kind, item.url);
    const group = groups.get(name);
    if (group === undefined) groups.set(name, { sample: item, count: 1 });
    else group.count += 1;
  }
  const ranked = [...groups.entries()]
    .toSorted(([, a], [, b]) => b.count - a.count)
    .slice(0, TOP_SOURCES);
  const most = ranked[0]?.[1].count ?? 1;
  return element(
    "ol",
    { class: "sources-rank" },
    ...ranked.map(([name, { sample, count }]) =>
      element(
        "li",
        {},
        sourceMark(sample.kind, sample.url),
        element("span", { class: "rank-name" }, name),
        svg(
          "svg",
          {
            class: "rank-bar",
            viewBox: "0 0 100 4",
            preserveAspectRatio: "none",
            "aria-hidden": "true",
          },
          svg("rect", { class: "bar-track", x: "0", y: "0", width: "100", height: "4" }),
          svg("rect", {
            class: sample.kind === "hn" ? "bar-hn" : "bar-changelog",
            x: "0",
            y: "0",
            width: String((count / most) * 100),
            height: "4",
          }),
        ),
        element("span", { class: "rank-count" }, String(count)),
      ),
    ),
  );
}

function hottest(items: readonly HeatItem[], copy: HeatLocale): HTMLElement[] {
  const stories = items
    .filter((item): item is HeatItem & { points: number } => item.points !== null)
    .toSorted((a, b) => b.points - a.points)
    .slice(0, TOP_DISCUSSIONS);
  if (stories.length === 0) return [];
  return [
    panel(
      copy.hottest,
      element(
        "ol",
        { class: "hot" },
        ...stories.map((story) =>
          element(
            "li",
            {},
            element(
              "span",
              { class: "hot-score", title: `${story.points} ${copy.points}` },
              String(story.points),
            ),
            element(
              "div",
              {},
              element("a", { href: deskUrl(`/items/${story.id}`) }, ...rich(story.title)),
              element(
                "span",
                { class: "hot-meta" },
                `${story.comments ?? 0} ${copy.comments}`,
                ...(story.tier === null ? [] : [element("span", { class: "tag" }, story.tier)]),
              ),
            ),
          ),
        ),
      ),
    ),
  ];
}

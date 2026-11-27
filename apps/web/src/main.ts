// oxlint-disable-next-line import/no-unassigned-import -- Runs before contract schemas initialize under the desk's strict CSP.
import "./zod-csp.ts";

import { getLocale, resolveLocale } from "@ai-moves/locales/registry";
import type { DeskErrorCode, LocalePack } from "@ai-moves/locales/types";

import { createDeskApi, linkCursor } from "./api.ts";
import { deskUrl, element, link } from "./dom.ts";
import { alertView, feedView } from "./feed.ts";
import { heatView, readHeatRange } from "./heat.ts";
import { createSubmissionsApi } from "./mcp.ts";
import { shellCopy, withSiteName } from "./shell.ts";
import { submissionsView } from "./submissions.ts";

const query = new URLSearchParams(location.search);
const buildLocale = resolveLocale(import.meta.env.VITE_LOCALE);
const locale = withSiteName(
  getLocale(resolveLocale(query.get("lang"), buildLocale)),
  import.meta.env.VITE_SITE_NAME,
);
applyShell(locale);

const statusElement = document.getElementById("status");
const contentElement = document.getElementById("content");
const feedAnchor = document.querySelector<HTMLAnchorElement>("#feed-link");
const heatAnchor = document.querySelector<HTMLAnchorElement>("#heat-link");
const submissionsAnchor = document.querySelector<HTMLAnchorElement>("#submissions-link");
// Only a deployment that serves an MCP endpoint has a submissions page.
const mcpPath = import.meta.env.VITE_MCP_PATH?.trim() || null;

if (statusElement && contentElement && feedAnchor && heatAnchor && submissionsAnchor) {
  feedAnchor.href = deskUrl("/");
  heatAnchor.href = deskUrl("/heat");
  submissionsAnchor.href = deskUrl("/submissions");
  submissionsAnchor.hidden = mcpPath === null;
  await loadDesk(statusElement, contentElement, {
    feed: feedAnchor,
    heat: heatAnchor,
    submissions: submissionsAnchor,
  });
}

function applyShell({ desk, lang }: LocalePack): void {
  document.documentElement.lang = lang;
  document.title = desk.siteName;
  for (const key of shellCopy) {
    for (const node of document.querySelectorAll(`[data-copy="${key}"]`)) {
      node.textContent = desk[key];
    }
  }
  document.querySelector("nav")?.setAttribute("aria-label", desk.navAriaLabel);
  document.querySelector<HTMLAnchorElement>(".brand")?.setAttribute("href", deskUrl("/"));
}

async function loadDesk(
  status: HTMLElement,
  content: HTMLElement,
  links: Readonly<Record<"feed" | "heat" | "submissions", HTMLAnchorElement>>,
): Promise<void> {
  // oxlint-disable-next-line no-restricted-globals -- Browser transport is confined to this application's relative API routes.
  const api = createDeskApi((path, init) => fetch(path, init));
  const { desk, lang } = locale;

  const [, kind, id] = location.pathname.split("/");
  if (kind === "submissions" && id === undefined) {
    // Without an MCP endpoint the route does not exist on this deployment.
    if (mcpPath === null) return showProblem("NOT_FOUND");
    links.submissions.setAttribute("aria-current", "page");
    // oxlint-disable-next-line no-restricted-globals -- Browser transport is confined to the deployment's same-origin MCP path.
    const submissions = createSubmissionsApi(mcpPath, (path, init) => fetch(path, init));
    const listed = await submissions.list();
    document.title = `${desk.submissions.title}${desk.titleSeparator}${desk.siteName}`;
    if (!listed.ok) {
      status.className = "notice";
      status.replaceChildren(element("p", {}, desk.submissions.errors[listed.code]));
      return;
    }
    show(submissionsView(listed.value, submissions, locale));
    return;
  }
  if (kind === "heat" && id === undefined) {
    links.heat.setAttribute("aria-current", "page");
    const range = readHeatRange(query.get("days"));
    const report = await api.heat(range);
    if (!report.ok) return showProblem(report.code);
    document.title = `${desk.heat.title}${desk.titleSeparator}${desk.siteName}`;
    show(heatView(report.value, range, locale));
    return;
  }
  links.feed.setAttribute("aria-current", "page");
  const cursor = linkCursor.safeParse(query.get("before"));
  const before = cursor.success ? cursor.data : null;
  if (kind === "alerts" && id !== undefined) {
    const detail = await api.alert(id, lang);
    if (!detail.ok) return showProblem(detail.code);
    showArticle(alertView(detail.value, locale));
    return;
  }
  if (kind === "items" && id !== undefined) {
    const detail = await api.item(id, before);
    if (!detail.ok) return showProblem(detail.code);
    const { item, alerts } = detail.value;
    const alert = item.kind === "hn" ? alerts.find((entry) => entry.kind === "new") : alerts.at(0);
    if (alert === undefined) {
      showArticle(alertView({ document: null }, locale, item));
      return;
    }
    const article = await api.alert(alert.id, lang);
    if (!article.ok) return showProblem(article.code);
    showArticle(alertView(article.value, locale, item));
    return;
  }

  const feed = await api.feed(before);
  if (!feed.ok) return showProblem(feed.code);
  show(feedView(feed.value.items, feed.value.next, before !== null, locale));

  function show(view: HTMLElement): void {
    status.hidden = true;
    content.replaceChildren(view);
  }

  function showArticle(view: HTMLElement): void {
    const heading = view.querySelector("h1");
    if (heading !== null) {
      document.title = `${heading.textContent}${desk.titleSeparator}${desk.siteName}`;
    }
    show(view);
  }

  function showProblem(code: DeskErrorCode): void {
    document.title = desk.siteName;
    status.className = "notice";
    status.replaceChildren(
      element("p", {}, desk.errors[code]),
      link(desk.backArrow, deskUrl("/"), "back"),
    );
  }
}

import { LangSchema } from "@ai-moves/contracts/primitives";

import { adminView } from "./admin.ts";
import { createDeskApi } from "./api.ts";
import { element, link } from "./dom.ts";
import { alertView, feedView } from "./feed.ts";

const status = document.getElementById("status");
const content = document.getElementById("content");
const adminLink = document.getElementById("admin-link");
const feedLink = document.getElementById("feed-link");

if (status && content && adminLink && feedLink) {
  // oxlint-disable-next-line no-restricted-globals -- Browser transport is confined to this application's relative API routes.
  const api = createDeskApi((path, init) => fetch(path, init));
  const query = new URLSearchParams(location.search);
  const admin = location.pathname === "/controls";
  const [, kind, id] = location.pathname.split("/");
  const before = query.get("before");
  const language = LangSchema.safeParse(query.get("lang"));
  const lang = language.success ? language.data : "zh-CN";

  const identity = await api.session();
  if (!identity.ok) {
    showProblem(identity.message);
  } else {
    adminLink.hidden = !identity.value.admin;
    (admin ? adminLink : feedLink).setAttribute("aria-current", "page");
    if (admin) {
      if (!identity.value.admin) {
        showProblem("你没有访问控制台的权限。");
      } else {
        const [destinations, configuration] = await Promise.all([
          api.destinations(),
          api.configuration(),
        ]);
        if (!destinations.ok) showProblem(destinations.message);
        else if (!configuration.ok) showProblem(configuration.message);
        else show(adminView(api, destinations.value.destinations, configuration.value.current));
      }
    } else if (kind === "alerts" && id !== undefined) {
      const detail = await api.alert(id, lang);
      if (detail.ok) show(alertView(detail.value));
      else showProblem(detail.message);
    } else if (kind === "items" && id !== undefined) {
      // A story has one living article; the newest alert carries it.
      const detail = await api.item(id, before);
      if (!detail.ok) showProblem(detail.message);
      else {
        const newest = detail.value.alerts.at(0);
        if (newest === undefined) {
          showProblem("这条还没有可读的内容。");
        } else {
          const article = await api.alert(newest.id, lang);
          if (article.ok) show(alertView(article.value));
          else showProblem(article.message);
        }
      }
    } else {
      const feed = await api.feed(before);
      if (feed.ok) show(feedView(feed.value.items, feed.value.next, before !== null));
      else showProblem(feed.message);
    }
  }
}

function show(view: HTMLElement): void {
  if (status) status.hidden = true;
  content?.replaceChildren(view);
}

function showProblem(message: string): void {
  if (!status) return;
  status.className = "notice";
  status.replaceChildren(element("p", {}, message), link("← 返回", "/", "back"));
}

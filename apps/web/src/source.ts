import type { ItemKind } from "@ai-news-tracker/contracts/states";

import { element } from "./dom.ts";

// Where a story came from, shown as a mark rather than a word where a mark reads
// faster. Hacker News gets its own orange square; a repository gets its owner's
// avatar; a documentation changelog gets a monogram of its site; a reader's submission
// gets a postbox mark.
const siteNames: Readonly<Record<string, string>> = {
  "code.claude.com": "Claude Code",
  "learn.chatgpt.com": "ChatGPT & Codex",
  "antigravity.google": "Antigravity",
  "news.ycombinator.com": "Hacker News",
};

interface Origin {
  readonly host: string;
  readonly owner: string | null;
  readonly repo: string | null;
}

function origin(url: string | null): Origin {
  const parsed = url === null ? null : URL.parse(url);
  if (parsed === null) return { host: "", owner: null, repo: null };
  const host = parsed.hostname.replace(/^www\./u, "");
  if (host !== "github.com") return { host, owner: null, repo: null };
  const [owner, repo] = parsed.pathname.split("/").filter((part) => part !== "");
  return { host, owner: owner ?? null, repo: repo ?? null };
}

export function sourceName(kind: ItemKind, url: string | null, fallback?: string): string {
  if (kind === "hn") return "Hacker News";
  const { host, owner, repo } = origin(url);
  // A submission is named by the site it points at, never by a repository path.
  if (kind === "submission") return siteNames[host] ?? fallback ?? host;
  if (owner !== null && repo !== null) return `${owner}/${repo}`;
  return siteNames[host] ?? fallback ?? host;
}

// A product's own mark, served from the desk rather than from the product's site, so
// the page stays on one origin and keeps working offline. Keyed by the documentation
// host or by the repository the releases come from.
const markFiles: Readonly<Record<string, string>> = {
  "code.claude.com": "claude.png",
  "learn.chatgpt.com": "codex.png",
  "antigravity.google": "antigravity.png",
  "earendil-works/pi": "pi.svg",
  "can1357/oh-my-pi": "oh-my-pi.svg",
  "stablyai/orca": "orca.png",
};

function markImage(src: string): HTMLElement {
  return element("img", {
    class: "mark mark-image",
    src,
    alt: "",
    loading: "lazy",
    width: "20",
    height: "20",
  });
}

export function sourceMark(kind: ItemKind, url: string | null): HTMLElement {
  if (kind === "hn") return element("span", { class: "mark mark-hn", "aria-hidden": "true" }, "Y");
  if (kind === "submission") {
    return element("span", { class: "mark mark-submission", "aria-hidden": "true" }, "📮");
  }
  const { host, owner, repo } = origin(url);
  const file = markFiles[owner === null || repo === null ? host : `${owner}/${repo}`];
  if (file !== undefined) return markImage(`/marks/${file}`);
  // A repository with no mark of its own is identified by its owner.
  if (owner !== null) {
    return markImage(`https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?size=48`);
  }
  const letter = (siteNames[host] ?? host).trim().slice(0, 1).toUpperCase();
  return element("span", { class: "mark mark-site", "aria-hidden": "true" }, letter || "·");
}

import type { AlertDoc } from "@ai-moves/contracts/alert-doc";

// How a card identifies its product at a glance: the product's own mark and an
// accent colour down the left edge. Both are chosen by the program from the source
// URL, never from model output.
export interface Brand {
  readonly color: number;
  readonly icon: string | null;
}

// The colour says what kind of card this is, not which product it is: green for a
// release, orange for a discussion, violet for a reader's submission. The product is
// identified by its mark, and a per-product colour only made the bar look like a status.
const RELEASE_COLOR = 0x3b_a5_5d;
const DISCUSSION_COLOR = 0xff_66_00;
const SUBMISSION_COLOR = 0x7c_5c_bf;

// Keyed by the documentation host or by the repository the releases come from.
// Discord does not render SVG in an embed, so every mark here is a raster image.
const MARKS: Readonly<Record<string, string>> = {
  "code.claude.com": "claude.png",
  "learn.chatgpt.com": "codex.png",
  "antigravity.google": "antigravity.png",
  "earendil-works/pi": "pi.png",
  "can1357/oh-my-pi": "oh-my-pi.png",
  "stablyai/orca": "orca.png",
};

function repository(url: string): { readonly owner: string; readonly repo: string } | null {
  const parsed = URL.parse(url);
  if (parsed === null || parsed.hostname.replace(/^www\./u, "") !== "github.com") return null;
  const [owner, repo] = parsed.pathname.split("/").filter((part) => part !== "");
  return owner === undefined || repo === undefined ? null : { owner, repo };
}

// The mark is served by the desk itself, so the icon URL is built from the public
// link the document already carries rather than from a separate configured origin.
export function brandOf(doc: AlertDoc, detailUrl: string): Brand {
  // A submission can point anywhere, so it never borrows a product's mark.
  if (doc.item_kind === "submission") return { color: SUBMISSION_COLOR, icon: null };
  const color = doc.item_kind === "hn" ? DISCUSSION_COLOR : RELEASE_COLOR;
  const parsed = URL.parse(doc.links.source);
  if (doc.item_kind === "hn" || parsed === null) return { color, icon: null };
  const where = repository(doc.links.source);
  const mark =
    MARKS[where === null ? parsed.hostname.replace(/^www\./u, "") : `${where.owner}/${where.repo}`];
  if (mark !== undefined) {
    return { color, icon: new URL(`/marks/${mark}`, detailUrl).toString() };
  }
  // A repository with no mark of its own is identified by its owner's avatar, which
  // GitHub serves as a raster image.
  if (where !== null) {
    return {
      color,
      icon: `https://avatars.githubusercontent.com/${encodeURIComponent(where.owner)}?size=64`,
    };
  }
  return { color, icon: null };
}

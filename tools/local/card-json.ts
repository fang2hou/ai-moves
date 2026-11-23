// Prints the Discord payload for one stored document, so the card can be inspected
// or pasted into a previewer without sending anything.
import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import { renderDiscord } from "@ai-moves/delivery/render/discord";

const desk = process.env.DESK_URL ?? "https://ai-moves-desk-dev.fang2hou.workers.dev";
const want = process.argv[2];
const feed = (await (await fetch(`${desk}/api/feed?limit=20`)).json()) as {
  items: { id: string; title: string }[];
};
const item =
  want === undefined
    ? feed.items[0]
    : feed.items.find(({ id, title }) => id === want || title.includes(want));
if (item === undefined) throw new Error(`No item matches ${want ?? "(first)"}`);
const detail = (await (await fetch(`${desk}/api/items/${item.id}`)).json()) as {
  alerts: { id: string }[];
};
const alert = detail.alerts[0];
if (alert === undefined) throw new Error(`No alert for ${item.title}`);
const page = (await (await fetch(`${desk}/api/alerts/${alert.id}`)).json()) as {
  document: Partial<AlertDoc> | null;
};
if (page.document === null) throw new Error(`No document for ${item.title}`);
// The public read path omits the fields a page has no use for; the renderer reads
// the stored document, so the few that are missing here are filled in.
const document = {
  v: 1,
  alert_id: alert.id,
  kind: "new",
  item_kind: page.document.links?.discussion == null ? "changelog" : "hn",
  tier: 2,
  generated_at: Date.now(),
  ...page.document,
} as AlertDoc;
console.log(JSON.stringify(renderDiscord(document), null, 2));

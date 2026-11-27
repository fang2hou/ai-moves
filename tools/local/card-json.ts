// Prints the Discord payload for one stored document, so the card can be inspected
// or pasted into a previewer without sending anything.
import { AlertDocSchema } from "@ai-moves/contracts/alert-doc";
import { AlertSchema, ItemSchema } from "@ai-moves/contracts/entities";
import { renderDiscord } from "@ai-moves/delivery/render/discord";
import { systemClock } from "@ai-moves/kernel/clock";
import { z } from "zod";

import { readEnv } from "./env.ts";

// The three desk pages this script reads, narrowed to the fields it uses.
const feedPage = z.object({
  items: z.array(ItemSchema.pick({ id: true, kind: true, title: true })),
});
const itemPage = z.object({ alerts: z.array(AlertSchema.pick({ id: true })) });
const alertPage = z.object({ document: AlertDocSchema.partial().nullable() });

const desk = readEnv("DESK_URL") ?? "https://ai-moves-desk-dev.fang2hou.workers.dev";
const want = process.argv[2];

async function readPage<Page extends z.ZodType>(
  schema: Page,
  path: string,
): Promise<z.output<Page>> {
  const body: unknown = await (await fetch(`${desk}${path}`)).json();
  return schema.parse(body);
}

const { items } = await readPage(feedPage, "/api/feed?limit=20");
const item =
  want === undefined
    ? items[0]
    : items.find(({ id, title }) => id === want || title.includes(want));
if (item === undefined) throw new Error(`No item matches ${want ?? "(first)"}`);
const { alerts } = await readPage(itemPage, `/api/items/${item.id}`);
const alert = alerts[0];
if (alert === undefined) throw new Error(`No alert for ${item.title}`);
const { document: published } = await readPage(alertPage, `/api/alerts/${alert.id}`);
if (published === null) throw new Error(`No document for ${item.title}`);
// The public read path omits the fields a page has no use for; the renderer reads
// the stored document, so the few that are missing here are filled in.
const document = AlertDocSchema.parse({
  v: 1,
  alert_id: alert.id,
  kind: "new",
  item_kind: item.kind,
  tier: 2,
  generated_at: systemClock.now(),
  ...published,
});
console.log(JSON.stringify(renderDiscord(document), null, 2));

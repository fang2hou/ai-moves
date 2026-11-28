import { createServer } from "node:http";

const port = Number(process.env.DISCORD_MOCK_PORT ?? 7373);
const deskPlaceholder = process.env.DESK_ORIGIN ?? "https://desk.example.test";
const deskLocal = process.env.DESK_LOCAL_URL ?? "http://localhost:8787";
const host = "127.0.0.1";
const maxBodyBytes = 64 * 1024;
const historyLimit = 50;

const history = [];
const streams = new Set();
let sequence = 0;

function snowflake() {
  sequence += 1;
  return `${Date.now()}${String(sequence).padStart(4, "0")}`;
}

function broadcast(message) {
  history.push(message);
  if (history.length > historyLimit) history.shift();
  const frame = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  for (const stream of streams) stream.write(frame);
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > maxBodyBytes) throw new Error("Payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>Discord mock — #ai-news-tracker-alerts</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #1e1f22; color: #dbdee1; font: 15px/1.45 "Inter",
    -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 8px; padding: 14px 20px;
    background: #2b2d31; border-bottom: 1px solid #1a1b1e; position: sticky; top: 0;
  }
  header strong { font-size: 15px; }
  header .hash { color: #80848e; font-size: 20px; }
  header .state { margin-left: auto; font-size: 12px; color: #80848e; }
  header .state[data-live="true"] { color: #23a55a; }
  main { max-width: 820px; margin: 0 auto; padding: 24px 20px 80px; }
  .empty { color: #80848e; font-size: 14px; }
  .msg { display: flex; gap: 14px; padding: 10px 0; }
  .avatar {
    width: 40px; height: 40px; border-radius: 50%; background: #5865f2; flex: 0 0 40px;
    display: grid; place-items: center; font-size: 18px;
  }
  .meta { display: flex; align-items: baseline; gap: 8px; }
  .name { font-weight: 600; color: #f2f3f5; }
  .bot { background: #5865f2; color: #fff; font-size: 10px; font-weight: 700;
    border-radius: 4px; padding: 1px 4px; text-transform: uppercase; }
  .time { color: #80848e; font-size: 12px; }
  .content { white-space: pre-wrap; margin: 4px 0 0; }
  .embed {
    margin-top: 6px; background: #2b2d31; border-left: 4px solid #5865f2;
    border-radius: 4px; padding: 12px 16px; max-width: 540px;
  }
  .embed .author { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .embed .author img { width: 24px; height: 24px; border-radius: 50%; }
  .embed .author span { font-size: 13px; font-weight: 600; color: #f2f3f5; }
  .embed a.title { color: #00a8fc; font-weight: 600; text-decoration: none; }
  .embed a.title:hover { text-decoration: underline; }
  .embed .desc { margin: 6px 0 0; font-size: 14px; }
  .embed .desc p { margin: 0 0 6px; }
  .embed .desc .li { display: flex; gap: 8px; margin: 0 0 2px; }
  .embed .desc .li::before { content: "•"; color: #949ba4; }
  .embed .desc .sub { font-size: 12.5px; color: #949ba4; margin: 0 0 8px 16px; }
  .embed .desc code {
    background: #1e1f22; border-radius: 4px; padding: 1px 4px;
    font-family: ui-monospace, Menlo, monospace; font-size: 85%;
  }
  .field { margin-top: 12px; }
  .field .fname { font-size: 13px; font-weight: 700; color: #f2f3f5; margin-bottom: 4px; }
  .field .fvalue { font-size: 14px; }
  .field .fvalue .li { display: flex; gap: 8px; margin: 0 0 2px; }
  .field .fvalue .li::before { content: "\u2022"; color: #949ba4; }
  .field .fvalue .sub { font-size: 12.5px; color: #949ba4; margin: 0 0 8px 16px; }
  .field .fvalue code {
    background: #1e1f22; border-radius: 4px; padding: 1px 4px;
    font-family: ui-monospace, Menlo, monospace; font-size: 85%;
  }
  .footer { margin-top: 10px; font-size: 12px; color: #80848e; }
  details.raw { margin-top: 8px; font-size: 12px; color: #949ba4; }
  details.raw pre { background: #111214; padding: 10px; border-radius: 4px; overflow: auto; }
  #toasts { position: fixed; top: 16px; right: 16px; display: grid; gap: 10px; z-index: 10; }
  .toast {
    background: #2b2d31; border: 1px solid #3f4147; border-left: 4px solid #23a55a;
    border-radius: 6px; padding: 12px 14px; width: 320px;
    box-shadow: 0 8px 24px rgba(0,0,0,.45); animation: in .18s ease-out;
  }
  .toast .tt { font-weight: 600; font-size: 13px; color: #f2f3f5; }
  .toast .tb { font-size: 13px; color: #b5bac1; margin-top: 4px;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  @keyframes in { from { opacity: 0; transform: translateX(12px); } }
</style>
</head>
<body>
<header>
  <span class="hash">#</span><strong>ai-news-tracker-alerts</strong>
  <span class="state" id="state">connecting…</span>
</header>
<main>
  <p class="empty" id="empty">No webhook messages yet. POST JSON to <code>/api/webhooks/1/mock</code>.</p>
  <div id="log"></div>
</main>
<div id="toasts"></div>
<script type="module">
  const DESK_PLACEHOLDER = ${JSON.stringify(deskPlaceholder)};
  const DESK_LOCAL = ${JSON.stringify(deskLocal)};
  const log = document.getElementById("log");
  const empty = document.getElementById("empty");
  const toasts = document.getElementById("toasts");
  const state = document.getElementById("state");
  const time = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" });

  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    node.append(...kids);
    return node;
  };

  // Discord renders a small subset of markdown in an embed description. The stand-in
  // shows the same subset, so a card here looks like the card Discord would draw.
  const INLINE = /\`([^\`\\n]+)\`|\\*\\*([^*\\n]+)\\*\\*|\\\\([\\\\*_~\`|\\[\\]<>#@-])/gu;
  function inline(text) {
    const parts = [];
    let cursor = 0;
    for (const match of text.matchAll(INLINE)) {
      if (match.index > cursor) parts.push(text.slice(cursor, match.index));
      if (match[1] !== undefined) parts.push(el("code", {}, match[1]));
      else if (match[2] !== undefined) parts.push(el("strong", {}, match[2]));
      else parts.push(match[3]);
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
  }

  function markdown(text) {
    const block = el("div", { class: "desc" });
    for (const line of text.split("\\n")) {
      if (line === "") continue;
      if (line.startsWith("-# ")) block.append(el("div", { class: "sub" }, ...inline(line.slice(3))));
      else if (line.startsWith("- ")) block.append(el("div", { class: "li" }, el("span", {}, ...inline(line.slice(2)))));
      else block.append(el("p", {}, ...inline(line)));
    }
    return block;
  }

  function render(message) {
    empty.hidden = true;
    const body = el("div", { style: "flex:1;min-width:0" });
    body.append(
      el("div", { class: "meta" },
        el("span", { class: "name" }, message.username ?? "AI News Tracker"),
        el("span", { class: "bot" }, "bot"),
        el("span", { class: "time" }, time.format(new Date(message.received_at))),
      ),
    );
    if (typeof message.payload?.content === "string" && message.payload.content !== "") {
      body.append(el("p", { class: "content" }, message.payload.content));
    }
    for (const embed of message.payload?.embeds ?? []) {
      const card = el("div", { class: "embed" });
      if (typeof embed.color === "number") {
        card.setAttribute("style", "border-left-color:#" + embed.color.toString(16).padStart(6, "0"));
      }
      if (embed.author?.name) {
        const author = el("div", { class: "author" });
        if (embed.author.icon_url) {
          const src = embed.author.icon_url.replace(DESK_PLACEHOLDER, DESK_LOCAL);
          author.append(el("img", { src, alt: "" }));
        }
        author.append(el("span", {}, embed.author.name));
        card.append(author);
      }
      if (embed.title) {
        // Documents must carry https links, so the desk origin is a placeholder.
        // Point it at the local desk so the card is clickable while testing.
        const href = typeof embed.url === "string"
          ? embed.url.replace(DESK_PLACEHOLDER, DESK_LOCAL)
          : null;
        card.append(href
          ? el("a", { class: "title", href, target: "_blank", rel: "noreferrer" }, embed.title)
          : el("div", { class: "title" }, embed.title));
      }
      if (embed.description) card.append(markdown(embed.description));
      for (const field of embed.fields ?? []) {
        const value = markdown(field.value);
        value.setAttribute("class", "fvalue");
        card.append(el("div", { class: "field" },
          el("div", { class: "fname" }, field.name),
          value,
        ));
      }
      const stamp = embed.timestamp ? time.format(new Date(embed.timestamp)) : "";
      const footer = [embed.footer?.text, stamp].filter(Boolean).join(" • ");
      if (footer) card.append(el("div", { class: "footer" }, footer));
      body.append(card);
    }
    const raw = el("details", { class: "raw" }, el("summary", {}, "raw JSON"));
    raw.append(el("pre", {}, JSON.stringify(message.payload, null, 2)));
    body.append(raw);
    log.prepend(el("div", { class: "msg" }, el("div", { class: "avatar" }, "✳"), body));
  }

  function toast(message) {
    const embed = message.payload?.embeds?.[0];
    const title = embed?.title ?? "New Discord message";
    const text = embed?.description ?? message.payload?.content ?? "(empty payload)";
    const node = el("div", { class: "toast" },
      el("div", { class: "tt" }, "#ai-news-tracker-alerts · " + title),
      el("div", { class: "tb" }, text),
    );
    toasts.append(node);
    setTimeout(() => node.remove(), 8000);
  }

  const source = new EventSource("/events");
  source.addEventListener("open", () => {
    state.textContent = "live";
    state.dataset.live = "true";
  });
  source.addEventListener("error", () => {
    state.textContent = "reconnecting…";
    state.dataset.live = "false";
  });
  source.addEventListener("history", (event) => {
    for (const message of JSON.parse(event.data)) render(message);
  });
  source.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    render(message);
    toast(message);
  });
</script>
</body>
</html>
`;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(page);
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write(`event: history\ndata: ${JSON.stringify(history)}\n\n`);
    streams.add(response);
    const beat = setInterval(() => response.write(": ping\n\n"), 25_000);
    request.on("close", () => {
      clearInterval(beat);
      streams.delete(response);
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/messages") {
    json(response, 200, { messages: history });
    return;
  }

  if (request.method === "POST" && /^\/api\/webhooks\/[^/]+\/[^/]+$/.test(url.pathname)) {
    void readBody(request)
      .then((raw) => {
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          json(response, 400, { message: "Invalid JSON body", code: 50_109 });
          return;
        }
        const message = {
          id: snowflake(),
          webhook: url.pathname,
          username: typeof payload?.username === "string" ? payload.username : "AI News Tracker",
          received_at: Date.now(),
          payload,
        };
        broadcast(message);
        process.stdout.write(`received ${message.id} on ${message.webhook}\n`);
        if (url.searchParams.get("wait") === "true") {
          json(response, 200, { id: message.id, channel_id: "mock-channel", type: 0 });
        } else {
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
        }
      })
      .catch(() => json(response, 413, { message: "Payload too large", code: 40_005 }));
    return;
  }

  json(response, 404, { message: "404: Not Found", code: 0 });
});

server.listen(port, host, () => {
  process.stdout.write(`Discord mock: http://${host}:${port}/\n`);
  process.stdout.write(`Webhook URL:  http://${host}:${port}/api/webhooks/1/mock\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const stream of streams) stream.end();
    server.close(() => process.exit(0));
  });
}

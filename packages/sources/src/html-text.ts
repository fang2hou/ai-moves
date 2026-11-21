const HTML_TAG = /<\/?([a-z][\w:-]*)(?=[\s/>])|<!|<\?/giy;
const INERT_ELEMENTS: ReadonlyMap<string, RegExp> = new Map([
  ["head", /<\/head\s*>/gi],
  ["script", /<\/script\s*>/gi],
  ["style", /<\/style\s*>/gi],
  ["template", /<\/template\s*>/gi],
  ["noscript", /<\/noscript\s*>/gi],
]);
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "div",
  "dl",
  "dt",
  "dd",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", " "],
  ["quot", '"'],
  ["mdash", "—"],
  ["ndash", "–"],
  ["hellip", "…"],
]);

function tagEnd(html: string, start: number): number {
  let quote = "";
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quote !== "") {
      if (char === quote) {
        quote = "";
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  return -1;
}

function entity(match: string): string {
  if (match[1] !== "#") {
    return NAMED_ENTITIES.get(match.slice(1, -1)) ?? match;
  }
  const hex = match[2]?.toLowerCase() === "x";
  const codePoint = Number.parseInt(match.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
  return codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ? "�"
    : String.fromCodePoint(codePoint);
}

export function extractHtmlText(html: string): string {
  let text = "";
  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open === -1) {
      text += html.slice(cursor);
      break;
    }
    text += html.slice(cursor, open);
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      if (end === -1) {
        break;
      }
      cursor = end + 3;
      continue;
    }
    HTML_TAG.lastIndex = open;
    const match = HTML_TAG.exec(html);
    if (match === null) {
      text += "<";
      cursor = open + 1;
      continue;
    }
    const end = tagEnd(html, HTML_TAG.lastIndex);
    if (end === -1) {
      break;
    }
    cursor = end;
    const name = match[1]?.toLowerCase();
    if (name === undefined) {
      continue;
    }
    const closing = INERT_ELEMENTS.get(name);
    if (closing !== undefined && html[open + 1] !== "/") {
      closing.lastIndex = end;
      if (closing.exec(html) === null) {
        break;
      }
      cursor = closing.lastIndex;
      text += " ";
    } else if (BLOCK_ELEMENTS.has(name)) {
      text += " ";
    }
  }
  return text
    .replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, entity)
    .replace(/\s+/g, " ")
    .trim();
}

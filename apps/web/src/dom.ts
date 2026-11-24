type Child = Node | string;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

export function link(text: string, href: string, className?: string): HTMLAnchorElement {
  return element("a", { href, ...(className === undefined ? {} : { class: className }) }, text);
}

export function deskUrl(path: string, fields: Record<string, string> = {}): string {
  const query = new URLSearchParams(fields);
  const preview = new URLSearchParams(location.search).get("lang");
  if (preview !== null) query.set("lang", preview);
  return query.size === 0 ? path : `${path}?${query}`;
}

export function dateLabel(at: number, dateLocale: string): HTMLTimeElement {
  const date = new Date(at);
  return element(
    "time",
    { datetime: date.toISOString() },
    date.toLocaleDateString(dateLocale, { dateStyle: "long", timeZone: "Asia/Tokyo" }),
  );
}

// Model prose may carry inline code and nothing else. Split on it rather than
// assigning markup, so the text is never interpreted as HTML.
const CODE = /`([^`\n]{1,200})`/gu;

export function rich(input: string): (Node | string)[] {
  const parts: (Node | string)[] = [];
  let cursor = 0;
  for (const match of input.matchAll(CODE)) {
    if (match.index > cursor) parts.push(input.slice(cursor, match.index));
    parts.push(element("code", {}, match[1] ?? ""));
    cursor = match.index + match[0].length;
  }
  if (cursor < input.length) parts.push(input.slice(cursor));
  return parts.length === 0 ? [input] : parts;
}

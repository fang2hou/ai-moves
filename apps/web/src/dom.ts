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

export function deskUrl(path: string, fields: Record<string, string>): string {
  return `${path}?${new URLSearchParams(fields)}`;
}

const formatDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

export function dateLabel(at: number): HTMLTimeElement {
  const date = new Date(at);
  return element("time", { datetime: date.toISOString() }, formatDate.format(date));
}

export function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

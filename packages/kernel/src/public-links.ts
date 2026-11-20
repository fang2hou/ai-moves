import type { AlertDoc } from "@ai-moves/contracts/alert-doc";

function sourceUrl(input: string): URL | null {
  const authority = /^https?:\/\/([^/\\?#]+)/iu.exec(input)?.[1];
  if (authority === undefined || authority.includes("@") || /\p{Cc}/u.test(input)) return null;
  const url = URL.parse(input);
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  )
    return null;
  return url;
}

export function observedSourceUrl(input: string | null): string | null {
  if (input === null) return null;
  const text = input.trim();
  return sourceUrl(text) === null ? null : withoutFragment(text);
}

export function publicLink(input: string | null): string | null {
  if (input === null) return null;
  const text = input.trim();
  const url = sourceUrl(text);
  if (url === null) return null;
  if (
    url.search !== "" &&
    !(
      url.origin === "https://news.ycombinator.com" &&
      url.pathname === "/item" &&
      /^\?id=[1-9][0-9]*$/u.test(url.search) &&
      Number.isSafeInteger(Number(url.search.slice(4)))
    )
  )
    return null;
  return withoutFragment(text);
}

function withoutFragment(input: string): string | null {
  const fragment = input.indexOf("#");
  const end = fragment === -1 ? input.length : fragment;
  if (end > 2048) return null;
  return fragment === -1 ? input : input.slice(0, end);
}

export function publicAlertLinks(
  input: Omit<AlertDoc["links"], "source"> & { readonly source: string | null },
): AlertDoc["links"] | null {
  const source = publicLink(input.source);
  const detail = publicLink(input.detail);
  if (source === null || detail === null) return null;
  return { source, detail, discussion: publicLink(input.discussion) };
}

export function linkMentions(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(/https?:\/\/[^\s<>\x60]+/giu);
}

export function withoutLinkPunctuation(mention: string): string {
  return mention.replace(/[\])}"'.,!;]+$/u, "");
}

export function hasPublicLinkText(text: string): boolean {
  for (const [mention] of linkMentions(text)) {
    const url = withoutLinkPunctuation(mention);
    if (url.includes("#") || publicLink(url) === null) return false;
  }
  return true;
}

export function publicAlertDocument(document: AlertDoc): AlertDoc | null {
  const links = publicAlertLinks(document.links);
  if (
    links === null ||
    !hasPublicLinkText(document.source_label) ||
    !hasPublicLinkText(document.title.original) ||
    (document.title.translated !== null && !hasPublicLinkText(document.title.translated)) ||
    !hasPublicLinkText(document.why_now) ||
    !hasPublicLinkText(document.summary) ||
    !document.key_points.every(
      (point) =>
        hasPublicLinkText(point.text) &&
        (point.evidence_quote === null || hasPublicLinkText(point.evidence_quote)),
    ) ||
    !document.engineering_implications.every(hasPublicLinkText) ||
    !document.caveats.every(hasPublicLinkText)
  )
    return null;
  return { ...document, links };
}

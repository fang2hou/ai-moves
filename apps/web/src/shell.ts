import type { LocalePack } from "@ai-moves/locales/types";

export const shellCopy = [
  "siteName",
  "skipToContent",
  "navLatest",
  "navHeat",
  "loading",
  "footer",
] as const;

// A deployment may give the desk its own name in every locale; blank keeps the pack's name.
export function withSiteName(pack: LocalePack, siteName: string | undefined): LocalePack {
  const name = siteName?.trim();
  return name ? { ...pack, desk: { ...pack.desk, siteName: name } } : pack;
}

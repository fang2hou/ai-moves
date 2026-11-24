import { LangSchema, type Lang } from "@ai-moves/contracts/primitives";

import { en } from "./packs/en.ts";
import { ja } from "./packs/ja.ts";
import { zhCN } from "./packs/zh-cn.ts";
import type { LocalePack } from "./types.ts";

export const DEFAULT_LOCALE = "en";

const packs: Readonly<Record<Lang, LocalePack>> = { en, "zh-CN": zhCN, ja };
const citationPrefixes = [
  ...new Set(Object.values(packs).flatMap((pack) => pack.prompt.citationPrefixes)),
];

export function getLocale(lang: Lang): LocalePack {
  return packs[lang];
}

export function resolveLocale(
  input: string | null | undefined,
  fallback: Lang = DEFAULT_LOCALE,
): Lang {
  const result = LangSchema.safeParse(input);
  return result.success ? result.data : fallback;
}

export function allCitationPrefixes(): readonly string[] {
  return citationPrefixes;
}

import { LANGS, LangSchema } from "@ai-news-tracker/contracts/primitives";
import { DEFAULT_LOCALE, getLocale } from "@ai-news-tracker/locales/registry";
import { defineConfig, loadEnv } from "vite";

import { shellCopy, withSiteName } from "./src/shell.ts";

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".");
  const configuredLocale = env["VITE_LOCALE"];
  const lang = LangSchema.parse(configuredLocale || DEFAULT_LOCALE, {
    error: () => `Invalid VITE_LOCALE "${configuredLocale}". Expected one of: ${LANGS.join(", ")}.`,
  });
  const { desk } = withSiteName(getLocale(lang), env["VITE_SITE_NAME"]);
  return {
    plugins: [
      {
        name: "desk-locale",
        transformIndexHtml(html) {
          let localized = html
            .replace('<html lang="en">', `<html lang="${lang}">`)
            .replace(/<title>[^<]*<\/title>/u, () => `<title>${escapeHtml(desk.siteName)}</title>`)
            .replace(
              /<nav aria-label="[^"]*">/u,
              () => `<nav aria-label="${escapeHtml(desk.navAriaLabel)}">`,
            );
          for (const key of shellCopy) {
            const text = new RegExp(`(data-copy="${key}">)[^<]*`, "gu");
            localized = localized.replace(text, (_, tag: string) => tag + escapeHtml(desk[key]));
          }
          return {
            html: localized,
            tags: [
              { tag: "meta", attrs: { name: "description", content: desk.siteDescription } },
              { tag: "meta", attrs: { property: "og:title", content: desk.siteName } },
              { tag: "meta", attrs: { property: "og:description", content: desk.siteDescription } },
              { tag: "meta", attrs: { property: "og:type", content: "website" } },
              { tag: "meta", attrs: { property: "og:site_name", content: desk.siteName } },
            ],
          };
        },
      },
    ],
  };
});

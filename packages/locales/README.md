# Locales

Locale packs define reader copy, site metadata, Discord labels, prompt writing rules, and citation prefixes. English (`en`) is the default. Simplified Chinese (`zh-CN`) and Japanese (`ja`) are also available.

Use `@ai-moves/locales/registry` to resolve settings and look up a pack by language. The registry also exposes the combined citation prefixes for sanitizing model output. The pack type is exported from `@ai-moves/locales/types`, and each pack has its own `@ai-moves/locales/packs/*` entry point.

To add a language, add its tag to the shared language contract, provide a complete pack, and register and export it. The desk selects its locale with `VITE_LOCALE` or a `?lang=` override. Analysis takes its language from `profile.output_lang`, and Discord uses the document language.

# Locales

Locale packs define reader copy, number and unit formatters, site metadata, Discord and Slack labels, prompt writing rules, and citation prefixes. English (`en`) is the default. Simplified Chinese (`zh-CN`) and Japanese (`ja`) are also available.

The delivery pack carries `submittedByLabel` (card context line and footer); the desk pack carries `submittedBy` (article page) and `heat.submissions` (heat stats, legend, and day tooltip) for MCP submissions. The desk pack's `navSubmissions` and `submissions` sub-object (`SubmissionsLocale`) carry the submissions page copy: title, state badges, AI reviewer `criteria` (`ReviewCriteriaLocale`), review decisions, alert outcome and block-reason wording, the `force` and `rereview` labels and confirmations, and its error notices.

Use `@ai-news-tracker/locales/registry` to resolve settings and look up a pack by language. The registry also exposes the combined citation prefixes for sanitizing model output. The pack type is exported from `@ai-news-tracker/locales/types`, and each pack has its own `@ai-news-tracker/locales/packs/*` entry point.

To add a language, add its tag to the shared language contract, provide a complete pack, and register and export it. The desk selects its locale with `VITE_LOCALE` or a `?lang=` override. Analysis takes its language from `profile.output_lang`, and the Discord and Slack renderers use the document language.

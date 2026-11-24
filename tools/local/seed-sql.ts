// Prints the rows a fresh deployment needs: the published configuration, the sources
// to poll, and the Discord destination. Applied with
// `wrangler d1 execute ai-moves --remote --file`. Values are literals, so this file
// never holds a secret: the destination names a secret binding, it does not carry one.
import { AppConfigSchema } from "@ai-moves/contracts/config";

const now = Date.now();
// The routes this project is allowed to run on, free one first.
const deep = {
  provider: "openrouter",
  model: "inclusionai/ling-3.2-flash-20261113:free",
  fallbacks: [
    "~deepseek/deepseek-flash-latest",
    "tencent/hy4-flash-20261116",
    "google/gemini-4-hydrogen-20261112",
  ],
  max_output_tokens: 32_000,
} as const;

const config = AppConfigSchema.parse({
  profile: { output_lang: "zh-CN" },
  watchlist: [
    { owner: "can1357", repo: "oh-my-pi" },
    { owner: "stablyai", repo: "orca" },
    { owner: "earendil-works", repo: "pi" },
  ],
  web_watchlist: [
    {
      label: "Claude Code",
      page_url: "https://code.claude.com/docs/en/changelog",
      fetch_url: "https://code.claude.com/docs/en/changelog.md",
    },
    { label: "ChatGPT & Codex", page_url: "https://learn.chatgpt.com/docs/changelog" },
    {
      label: "Antigravity",
      page_url: "https://antigravity.google/docs/changelog",
      fetch_url: "https://antigravity.google/docs/changelog.md",
      surfaces: ["Antigravity App", "Antigravity CLI"],
    },
  ],
  models: {
    triage: { ...deep, max_output_tokens: 8000 },
    deep,
    translate: deep,
  },
  // A personal feed: send for real, and do not space the cards out, or a cold start
  // that finds seven releases at once would suppress six of them.
  delivery: {
    feed_only: false,
    force_dry_run: false,
    min_interval_minutes: 0,
    daily_budget_per_destination: 25,
    daily_cap_per_source: { hn: 10, changelog: 15 },
  },
});

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const json = (value: unknown): string => quote(JSON.stringify(value));
const lines: string[] = [];

lines.push(
  `INSERT OR REPLACE INTO config_versions (version, config_json, created_at, created_by) VALUES (1, ${json(config)}, ${now}, 'deploy');`,
);

const source = (
  id: string,
  key: string,
  kind: string,
  configJson: unknown,
  cursorJson: unknown,
  interval: number,
): void => {
  lines.push(
    `INSERT OR REPLACE INTO sources (id, key, kind, config_json, poll_interval_sec, next_poll_at, cursor_json, consecutive_failures, status, last_success_at, created_at, updated_at) VALUES (${quote(id)}, ${quote(key)}, ${quote(kind)}, ${json(configJson)}, ${interval}, ${now}, ${json(cursorJson)}, 0, 'active', NULL, ${now}, ${now});`,
  );
};

source(
  "hn-top",
  "hn:top",
  "hn_top",
  { kind: "hn_top", top_n: config.hn.top_n, track_limit: config.hn.track_limit },
  { kind: "hn_top" },
  300,
);
for (const entry of config.watchlist) {
  const key = `${entry.owner.toLowerCase()}/${entry.repo.toLowerCase()}`;
  source(
    `gh-${key.replace("/", "-")}`,
    `github:${key}`,
    "github_repo",
    {
      kind: "github_repo",
      owner: entry.owner,
      repo: entry.repo,
      strategy: entry.strategy,
      changelog_path: entry.changelog_path,
    },
    {
      kind: "github_repo",
      releases_etag: null,
      tags_etag: null,
      changelog_sha: null,
      known_versions: [],
    },
    entry.poll_interval_sec,
  );
}
for (const entry of config.web_watchlist) {
  const host = new URL(entry.page_url).hostname;
  source(
    `web-${host.replace(/\W+/gu, "-")}`,
    `web:${entry.page_url}`,
    "web_page",
    {
      kind: "web_page",
      label: entry.label,
      page_url: entry.page_url,
      fetch_url: entry.fetch_url ?? entry.page_url,
      surfaces: [...entry.surfaces],
    },
    { kind: "web_page", content_hash: null, latest_markers: [] },
    entry.poll_interval_sec,
  );
}

lines.push(
  `INSERT OR REPLACE INTO destinations (id, name, purpose, channel, secret_ref, lang, enabled, dry_run, min_tier, daily_budget, source_filters_json, quiet_hours_json, created_at, updated_at) VALUES ('discord-main', 'Discord', 'alerts', 'discord', 'DISCORD_WEBHOOK_URL', 'zh-CN', 1, 0, 1, ${config.delivery.daily_budget_per_destination}, ${json({ hn: true, changelog: true })}, NULL, ${now}, ${now});`,
);

console.log(lines.join("\n"));

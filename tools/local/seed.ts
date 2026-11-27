// The rows a fresh deployment needs, built once for every storage backend: the published
// configuration, the sources to poll, and one notification destination. Values are literals, so
// this file never holds a secret: the destination names a secret, it does not carry one.
import { AppConfigSchema, type AppConfig } from "@ai-moves/contracts/config";
import { SourceSchema, type Destination } from "@ai-moves/contracts/entities";
import type { NewSource } from "@ai-moves/contracts/ports/storage";
import { LangSchema, type EpochMs, type Lang } from "@ai-moves/contracts/primitives";
import { DestinationChannelSchema, type DestinationChannel } from "@ai-moves/contracts/states";

import { z } from "zod";

import { readEnv } from "./env.ts";

export interface Seed {
  readonly config: AppConfig;
  readonly sources: readonly NewSource[];
  readonly destination: Destination;
}

export interface SeedOptions {
  readonly now: EpochMs;
  // The language documents are written in and the destination receives.
  readonly lang: Lang;
  readonly channel: DestinationChannel;
  readonly llm: SeedLlm;
}

export const SEED_LLMS = ["openrouter", "hyper", "bedrock"] as const;
export type SeedLlm = (typeof SEED_LLMS)[number];

const SECRET_BY_CHANNEL = {
  discord: "DISCORD_WEBHOOK_URL",
  slack: "SLACK_WEBHOOK_URL",
} as const satisfies Record<DestinationChannel, string>;

// SEED_OUTPUT_LANG and SEED_CHANNEL select the deployment's language and destination; unset, they
// keep the personal deployment's zh-CN Discord feed.
export function seedOptionsFromEnv(now: EpochMs): SeedOptions {
  return {
    now,
    lang: LangSchema.parse(readEnv("SEED_OUTPUT_LANG") ?? "zh-CN"),
    channel: DestinationChannelSchema.parse(readEnv("SEED_CHANNEL") ?? "discord"),
    llm: z.enum(SEED_LLMS).parse(readEnv("SEED_LLM") ?? "openrouter"),
  };
}

export function buildSeed({ now, lang, channel, llm }: SeedOptions): Seed {
  const openrouter = {
    provider: "openrouter",
    model: "inclusionai/ling-3.2-flash-20261113:free",
    fallbacks: [
      "~deepseek/deepseek-flash-latest",
      "tencent/hy4-flash-20261116",
      "google/gemini-4-hydrogen-20261112",
    ],
  };
  const routes = {
    openrouter,
    hyper: {
      provider: "hyper",
      model: "deepseek-v4.1-flash-1017-economy",
      fallbacks: ["deepseek-v4.1-flash-1017"],
      effort: "high",
      fallback_routes: [openrouter],
    },
    bedrock: {
      provider: "bedrock",
      model: "anthropic.claude-sonnet-5-5",
      fallbacks: ["anthropic.claude-sonnet-5"],
      effort: "medium",
    },
  };
  const deep = { ...routes[llm], max_output_tokens: 32_000 };

  // Materialize the shared HN scoring and push defaults in the versioned seed row.
  const config = AppConfigSchema.parse({
    profile: { output_lang: lang },
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
    ai: {
      refresh_interval_minutes: 180,
      refresh_min_new_comments: 20,
      refresh_max_age_hours: 24,
    },
    models: {
      triage: { ...deep, max_output_tokens: 8000, ...(llm === "hyper" ? { effort: "low" } : {}) },
      deep,
      translate: deep,
    },
    // A personal feed: send for real, and do not space the cards out, or a cold start
    // that finds seven releases at once would suppress six of them.
    delivery: {
      feed_only: false,
      force_dry_run: false,
      min_interval_minutes: 0,
    },
  });

  const source = (
    id: string,
    key: string,
    kind: NewSource["kind"],
    configJson: unknown,
    cursorJson: unknown,
    interval: number,
    nextPollAt: EpochMs = now,
  ): NewSource => {
    const parsed = SourceSchema.parse({
      id,
      key,
      kind,
      config_json: configJson,
      poll_interval_sec: interval,
      next_poll_at: nextPollAt,
      cursor_json: cursorJson,
      consecutive_failures: 0,
      status: "active",
      last_success_at: null,
      created_at: now,
      updated_at: now,
    });
    const {
      consecutive_failures: _failures,
      status: _status,
      last_success_at: _success,
      ...row
    } = parsed;
    return row;
  };

  const sources: NewSource[] = [
    source(
      "hn-top",
      "hn:top",
      "hn_top",
      { kind: "hn_top", top_n: config.hn.top_n, track_limit: config.hn.track_limit },
      { kind: "hn_top" },
      300,
    ),
    // Every submitted item belongs to this row. It is never polled: its next poll is the end of
    // year 9999, matching what `submitItem` writes when it creates the row itself.
    source(
      "submission",
      "submission",
      "submission",
      { kind: "submission" },
      { kind: "submission" },
      86_400,
      253_402_300_799_000,
    ),
  ];
  for (const entry of config.watchlist) {
    const key = `${entry.owner.toLowerCase()}/${entry.repo.toLowerCase()}`;
    sources.push(
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
      ),
    );
  }
  for (const entry of config.web_watchlist) {
    const host = new URL(entry.page_url).hostname;
    sources.push(
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
      ),
    );
  }

  const destination: Destination = {
    id: `${channel}-main`,
    name: channel === "discord" ? "Discord" : "Slack",
    purpose: "alerts",
    channel,
    secret_ref: SECRET_BY_CHANNEL[channel],
    lang,
    enabled: true,
    dry_run: false,
    min_tier: 1,
    source_filters: { hn: true, changelog: true, submission: true },
    quiet_hours: null,
    created_at: now,
    updated_at: now,
  };

  return { config, sources, destination };
}

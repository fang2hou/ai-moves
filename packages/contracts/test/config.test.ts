import { describe, expect, it } from "vitest";

import { AppConfigSchema, RuntimeEnvSchema } from "../src/config.ts";
import { SAMPLE } from "./samples.ts";

describe("application config defaults", () => {
  const config = AppConfigSchema.parse({ models: SAMPLE.models });

  it("needs only the model mapping", () => {
    expect(config.models.deep.model).toBe("fake-large");
  });

  it("is a fixed point of its own schema", () => {
    expect(AppConfigSchema.parse(config)).toEqual(config);
  });

  it("defaults AI budgets to architecture 5.3", () => {
    expect(config.ai).toEqual({
      enabled: true,
      triage_items_per_day: 200,
      deep_per_day: 20,
      triage_batch_input_tokens: 6000,
      deep_input_tokens: 12_000,
      budget_alert_ratio: 0.8,
    });
  });

  it("defaults HN scoring to architecture 6.1", () => {
    expect(config.hn.window_minutes).toBe(30);
    expect(config.hn.heat_weights).toEqual({
      vp: 0.35,
      vc: 0.25,
      climb: 0.15,
      acc: 0.15,
      points: 0.1,
    });
    expect(config.hn.heat_levels).toEqual({ h1: 70, h2: 85, h3: 95 });
    expect(config.hn.gate_burst).toEqual({
      consecutive_samples: 2,
      heat: 70,
      single_sample_heat: 90,
      min_points: 20,
      max_age_hours: 24,
    });
    expect(config.hn.gate_discussion).toEqual({ vc_percentile: 0.9, min_comments: 30 });
    expect(config.hn.gate_sustained).toEqual({ consecutive_samples: 3, max_rank: 10 });
    expect(config.hn.cold_start).toEqual({ vp_per_hour: 60, vc_per_hour: 40 });
  });

  it("defaults the changelog prior to architecture 6.2", () => {
    expect(config.changelog.prior_points).toEqual({
      new_surface: 30,
      breaking: 25,
      default_change: 15,
      long_notes: 10,
      semver_minor_or_major: 10,
      fix_or_deps_only: -20,
      prerelease: -10,
    });
    expect(config.changelog.max_triage_per_repo_per_day).toBe(3);
  });

  it("defaults push thresholds to architecture 6.4", () => {
    expect(config.push).toEqual({
      hn: { min_importance: 4, borderline_importance: 3, borderline_min_heat_level: "H2" },
      changelog: { min_impact: 3, borderline_impact: 2, borderline_min_prior: 40 },
    });
  });

  it("defaults delivery to the low-noise settings of architecture 9.3", () => {
    expect(config.delivery).toEqual({
      paused: false,
      force_dry_run: true,
      daily_budget_per_destination: 8,
      daily_cap_per_source: { hn: 5, changelog: 5 },
      low_budget_threshold: 2,
      min_interval_minutes: 10,
      budget_timezone: "Asia/Tokyo",
      quiet_hours: { start: "23:00", end: "07:00", timezone: "Asia/Tokyo" },
      max_updates_per_item: 1,
      expiry_hours: { hn: 6, changelog: 24 },
      ops_max_per_hour: 1,
    });
  });

  it("defaults retries and leases to architecture 4.4 and 4.5", () => {
    expect(config.retry.deliver).toEqual({
      max_attempts: 5,
      backoff_seconds: [30, 120, 600, 1800],
    });
    expect(config.retry.poll).toEqual({ degraded_after_failures: 3, max_backoff_seconds: 3600 });
    expect(config.retry.analysis).toEqual({
      max_queue_retries: 3,
      repair_retries: 1,
      fallback_attempts: 1,
    });
    expect(config.leases).toEqual({ triage_minutes: 10, deep_minutes: 15, deliver_minutes: 5 });
  });

  it("defaults web fetching to the limits of architecture 10", () => {
    expect(config.timeouts.web_fetch_ms).toBe(10_000);
    expect(config.web_fetch).toEqual({
      max_redirects: 3,
      max_bytes: 1_048_576,
      content_types: ["text/html", "text/plain", "application/xhtml+xml"],
      denied_domains: [],
    });
  });

  it("starts with an empty watchlist and merges partial overrides with defaults", () => {
    expect(config.watchlist).toEqual([]);
    const custom = AppConfigSchema.parse({
      models: SAMPLE.models,
      delivery: { quiet_hours: { start: "22:00" } },
      watchlist: [{ owner: "o", repo: "r" }],
    });
    expect(custom.delivery.quiet_hours).toEqual({
      start: "22:00",
      end: "07:00",
      timezone: "Asia/Tokyo",
    });
    expect(custom.delivery.daily_budget_per_destination).toBe(8);
    expect(custom.watchlist).toEqual([
      {
        owner: "o",
        repo: "r",
        strategy: "release_first",
        changelog_path: "CHANGELOG.md",
        poll_interval_sec: 600,
      },
    ]);
  });
});

describe("runtime environment", () => {
  it("defaults the log level and ignores bindings and secrets", () => {
    expect(
      RuntimeEnvSchema.parse({ ENVIRONMENT: "dev", DB: {}, OPENROUTER_API_KEY: "sk" }),
    ).toEqual({
      ENVIRONMENT: "dev",
      LOG_LEVEL: "info",
    });
  });

  it("rejects an unknown environment", () => {
    expect(RuntimeEnvSchema.safeParse({ ENVIRONMENT: "staging" }).success).toBe(false);
  });
});

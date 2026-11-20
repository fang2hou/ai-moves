import type { AppConfig } from "@ai-moves/contracts/config";
import type { ChangelogScore, ChangelogSignalHit } from "@ai-moves/contracts/scoring";
import type { ChangelogSignal } from "@ai-moves/contracts/scoring";

export interface ChangelogSignalInput {
  readonly signal: ChangelogSignal;
  readonly evidence: readonly string[];
}

export interface ScoreChangelogInput {
  readonly signals: readonly ChangelogSignalInput[];
  readonly config: AppConfig["changelog"];
  readonly computedAt: number;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function scoreChangelog(input: ScoreChangelogInput): ChangelogScore {
  const signals: ChangelogSignalHit[] = input.signals.map((hit) => ({
    signal: hit.signal,
    points: input.config.prior_points[hit.signal],
    evidence: [...hit.evidence],
  }));
  const prior = clampScore(signals.reduce((total, signal) => total + signal.points, 0));
  return { kind: "changelog", prior, signals, computed_at: input.computedAt };
}

import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import type { AppConfig } from "@ai-moves/contracts/config";
import type { Alert, Destination, Item, QuietHours } from "@ai-moves/contracts/entities";
import type { Notifier } from "@ai-moves/contracts/ports/notifier";
import type { Clock } from "@ai-moves/contracts/ports/runtime";
import type {
  AlertRepo,
  DeliveryRepo,
  DestinationRepo,
  ItemRepo,
} from "@ai-moves/contracts/ports/storage";
import type { DeliverySuppressionReason } from "@ai-moves/contracts/states";
import { decideDelivery } from "@ai-moves/core/policy/delivery";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { publicAlertDocument, publicLink } from "@ai-moves/kernel/public-links";
import { withTimeout } from "@ai-moves/kernel/timeout";

import { finishSend } from "./attempt.ts";

export interface DeliveryPorts {
  readonly alerts: Pick<AlertRepo, "get" | "getDocument">;
  readonly deliveries: Pick<DeliveryRepo, "get" | "transition" | "claimForSend">;
  readonly destinations: Pick<DestinationRepo, "get">;
  readonly items: Pick<ItemRepo, "get">;
  readonly clock: Clock;
  readonly notifiers: Readonly<Record<"slack" | "discord", Notifier>>;
}

function isQuiet(at: number, hours: QuietHours): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: hours.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  return hours.start <= hours.end
    ? parts >= hours.start && parts < hours.end
    : parts >= hours.start || parts < hours.end;
}

export async function executeDelivery(
  ports: DeliveryPorts,
  id: string,
  config: AppConfig,
): Promise<void> {
  const row = await ports.deliveries.get(id);
  if (row === null || (row.state !== "pending" && row.state !== "failed_retryable")) return;
  const now = ports.clock.now();
  const expected = { state_updated_at: row.state_updated_at, attempts: row.attempts };
  if (row.expires_at <= now) {
    await ports.deliveries.transition({ id, from: row.state, to: "expired", at: now, expected });
    return;
  }
  if (row.next_attempt_at !== null && row.next_attempt_at > now) return;
  const alert = await ports.alerts.get(row.alert_id);
  const destination = await ports.destinations.get(row.destination_id);
  const item = alert === null ? null : await ports.items.get(alert.item_id);
  if (alert === null || item === null) return;
  if (destination === null) {
    await ports.deliveries.transition({
      id,
      from: row.state,
      to: "suppressed",
      at: now,
      expected,
      patch: { suppressed_reason: "destination_disabled", next_attempt_at: null },
    });
    return;
  }
  const policy = decideDelivery({
    itemTier: alert.tier,
    destination: {
      enabled:
        destination.enabled &&
        (destination.channel !== "discord" || destination.purpose === "alerts"),
      minTier: destination.min_tier,
      sourceAllowed: destination.source_filters[item.kind],
      muted: false,
    },
    global: {
      paused: config.delivery.paused,
      quietHours:
        isQuiet(now, config.delivery.quiet_hours) ||
        (destination.quiet_hours !== null && isQuiet(now, destination.quiet_hours)),
      minutesSincePrevious: null,
    },
    config: config.delivery,
    expiresAt: row.expires_at,
    now,
    isUpdate: alert.kind === "update",
    updatesSent: 0,
  });
  if (policy.action !== "send") {
    await ports.deliveries.transition({
      id,
      from: row.state,
      to: policy.action === "expire" ? "expired" : "suppressed",
      at: now,
      expected,
      patch:
        policy.action === "suppress"
          ? { suppressed_reason: policy.reason, next_attempt_at: null }
          : { next_attempt_at: null },
    });
    return;
  }
  let discordDoc: AlertDoc | null = null;
  if (destination.channel === "discord") {
    let reason = discordScoreRejection(alert);
    if (reason === null) {
      const stored = await ports.alerts.getDocument(row.alert_id, row.lang);
      discordDoc = verifiedDiscordDocument(stored, alert, item, destination, row.lang);
      if (discordDoc === null) reason = "unverified_content";
    }
    if (reason !== null) {
      await ports.deliveries.transition({
        id,
        from: row.state,
        to: "suppressed",
        at: now,
        expected,
        patch: { suppressed_reason: reason, next_attempt_at: null },
      });
      return;
    }
  } else if (alert.decision !== "send") return;

  const dryRun = row.dry_run || destination.dry_run || config.delivery.force_dry_run;
  let claimed;
  if (dryRun) {
    const won = await ports.deliveries.transition({
      id,
      from: row.state,
      to: "sending",
      at: now,
      expected,
      patch: { attempts: row.attempts + 1, next_attempt_at: null },
    });
    if (!won) return;
    claimed = {
      ...row,
      state: "sending" as const,
      state_updated_at: now,
      attempts: row.attempts + 1,
    };
  } else {
    const result = await ports.deliveries.claimForSend({
      id,
      from: row.state,
      expected,
      at: now,
      minIntervalMinutes: config.delivery.min_interval_minutes,
      maxUpdatesPerItem: config.delivery.max_updates_per_item,
    });
    if (result.kind !== "claimed") return;
    claimed = result.delivery;
  }
  await finishSend(
    ports.deliveries,
    ports.clock,
    claimed,
    async () => {
      const stored = discordDoc ?? (await ports.alerts.getDocument(claimed.alert_id, claimed.lang));
      if (stored === null) throw new AppError("NOT_FOUND");
      const doc = discordDoc ?? publicAlertDocument(stored);
      if (doc === null) throw new AppError("CONTENT_UNSUPPORTED");
      if (dryRun) return { provider_message_id: null };
      const current = await ports.deliveries.get(claimed.id);
      if (
        current?.state !== "sending" ||
        current.attempts !== claimed.attempts ||
        current.state_updated_at !== claimed.state_updated_at ||
        ports.clock.now() - claimed.state_updated_at >= config.leases.deliver_minutes * 60_000
      ) {
        throw new AppError("OUTCOME_UNKNOWN");
      }
      // Bounded here, where the configuration is in scope. The notifier port carries no abort
      // signal, so the request itself is not cancelled: the delivery only stops waiting, and
      // because the message may still arrive the deadline is an unknown outcome, not a retry.
      return withTimeout(
        () => ports.notifiers[destination.channel].send(destination, doc, claimed.idempotency_key),
        { timeoutMs: config.timeouts.notifier_ms, code: "OUTCOME_UNKNOWN" },
      );
    },
    {
      maxAttempts: config.retry.deliver.max_attempts,
      backoffSeconds: config.retry.deliver.backoff_seconds,
    },
  );
}

// The alert decision already applied the configured push thresholds, against the same
// configuration version. Re-deriving them here only let the two drift apart, so this
// reads the decision rather than second-guessing it.
function discordScoreRejection(alert: Alert): DeliverySuppressionReason | null {
  const { blocked_by: blockedBy } = alert.decision_reason_json;
  if (blockedBy.includes("rollout_feed_only")) return "rollout_feed_only";
  if (blockedBy.includes("below_tier")) return "below_tier";
  if (alert.decision !== "send" || blockedBy.length !== 0) return "unverified_content";
  return null;
}

// The document a card is built from has to be the one this alert produced, in the
// destination's language, and not a fallback. It is no longer required to be a
// translation or to carry a quote: analysis writes the output language directly, and
// a card prints the reading rather than the evidence behind it.
function verifiedDiscordDocument(
  stored: AlertDoc | null,
  alert: Alert,
  item: Item,
  destination: Destination,
  lang: AlertDoc["lang"],
): AlertDoc | null {
  if (
    stored === null ||
    stored.alert_id !== alert.id ||
    stored.kind !== alert.kind ||
    stored.tier !== alert.tier ||
    stored.item_kind !== item.kind ||
    stored.lang !== lang ||
    destination.lang !== lang ||
    stored.translation.fell_back_to_english ||
    stored.title.original !== item.title
  ) {
    return null;
  }
  const doc = publicAlertDocument(stored);
  if (doc === null) return null;
  const story = item.kind === "hn" ? /^hn:([1-9]\d*)$/u.exec(item.external_key)?.[1] : undefined;
  const discussion = story === undefined ? null : `https://news.ycombinator.com/item?id=${story}`;
  if ((item.kind === "hn" && discussion === null) || doc.links.discussion !== discussion)
    return null;
  // A submission's public name is the one its item recorded, so a card never credits
  // anyone else. Its source is the submitted URL, which is the item's own `url`.
  const submitter = item.score_json?.kind === "submission" ? item.score_json.submitter.name : null;
  if (doc.submitted_by !== submitter) return null;
  const source = item.url === null ? discussion : publicLink(item.url);
  return source !== null && doc.links.source === source ? doc : null;
}

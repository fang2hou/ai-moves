import type { AppConfig } from "@ai-moves/contracts/config";
import type { QuietHours } from "@ai-moves/contracts/entities";
import type { Notifier } from "@ai-moves/contracts/ports/notifier";
import type { Clock } from "@ai-moves/contracts/ports/runtime";
import type {
  AlertRepo,
  BudgetLedger,
  DeliveryRepo,
  DestinationRepo,
  ItemRepo,
} from "@ai-moves/contracts/ports/storage";
import { stableKey } from "@ai-moves/core/idempotency";
import { decideDelivery } from "@ai-moves/core/policy/delivery";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import { finishSend } from "./attempt.ts";

export interface DeliveryPorts {
  readonly alerts: Pick<AlertRepo, "get" | "getDocument">;
  readonly deliveries: Pick<DeliveryRepo, "get" | "transition" | "claimForSend">;
  readonly destinations: Pick<DestinationRepo, "get">;
  readonly items: Pick<ItemRepo, "get">;
  readonly budgets: Pick<BudgetLedger, "get" | "tryConsume">;
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

function dayInZone(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
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
  const day = dayInZone(now, config.delivery.budget_timezone);
  const destinationScope = `notify:destination:${destination.id}`;
  const sourceScope = `notify:source:${item.kind}`;
  const destinationLedger = await ports.budgets.get(day, destinationScope);
  const sourceLedger = await ports.budgets.get(day, sourceScope);
  const destinationLimit =
    destinationLedger?.limit ??
    Math.min(destination.daily_budget, config.delivery.daily_budget_per_destination);
  const sourceLimit = sourceLedger?.limit ?? config.delivery.daily_cap_per_source[item.kind];
  const policy = decideDelivery({
    itemKind: item.kind,
    itemTier: alert.tier,
    destination: {
      enabled: destination.enabled,
      minTier: destination.min_tier,
      dailyBudget: destinationLimit,
      usedToday: destinationLedger?.used ?? 0,
      sourceAllowed: destination.source_filters[item.kind],
      muted: false,
    },
    global: {
      paused: config.delivery.paused,
      quietHours:
        isQuiet(now, config.delivery.quiet_hours) ||
        (destination.quiet_hours !== null && isQuiet(now, destination.quiet_hours)),
      sourceUsedToday: sourceLedger?.used ?? 0,
      minutesSincePrevious: null,
    },
    config: {
      ...config.delivery,
      daily_cap_per_source: { ...config.delivery.daily_cap_per_source, [item.kind]: sourceLimit },
    },
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
  if (alert.decision !== "send") return;
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
      const doc = await ports.alerts.getDocument(claimed.alert_id, claimed.lang);
      if (doc === null) throw new AppError("NOT_FOUND");
      if (dryRun) return { provider_message_id: null };
      const attemptDay = dayInZone(ports.clock.now(), config.delivery.budget_timezone);
      const workId = stableKey("delivery-attempt", claimed.id, String(claimed.attempts));
      const limits = [
        {
          scope: `notify:destination:${destination.id}`,
          limit: Math.min(destination.daily_budget, config.delivery.daily_budget_per_destination),
        },
        {
          scope: `notify:source:${item.kind}`,
          limit: config.delivery.daily_cap_per_source[item.kind],
        },
      ];
      for (const { scope, limit } of limits) {
        const existing = await ports.budgets.get(attemptDay, scope);
        const grant = await ports.budgets.tryConsume({
          scope,
          day: attemptDay,
          workId,
          amount: 1,
          limit: existing?.limit ?? limit,
        });
        if (!grant.granted) throw new AppError("BUDGET_EXHAUSTED");
      }
      const current = await ports.deliveries.get(claimed.id);
      if (
        current?.state !== "sending" ||
        current.attempts !== claimed.attempts ||
        current.state_updated_at !== claimed.state_updated_at ||
        ports.clock.now() - claimed.state_updated_at >= config.leases.deliver_minutes * 60_000
      ) {
        throw new AppError("OUTCOME_UNKNOWN");
      }
      return ports.notifiers[destination.channel].send(destination, doc, claimed.idempotency_key);
    },
    {
      maxAttempts: config.retry.deliver.max_attempts,
      backoffSeconds: config.retry.deliver.backoff_seconds,
    },
  );
}

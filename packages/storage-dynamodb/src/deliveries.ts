import type { Delivery } from "@ai-news-tracker/contracts/entities";
import type {
  DeliveryPatch,
  DeliveryRepo,
  DeliverySendClaim,
} from "@ai-news-tracker/contracts/ports/storage";
import { isDeliveryTransitionAllowed } from "@ai-news-tracker/contracts/states";
import { summarizeDurableError } from "@ai-news-tracker/kernel/errors/app-error";
import { compareId, matchesVersion, sendIntervalCutoff } from "@ai-news-tracker/storage/rules";

import { revCondition, type WriteOp } from "./client.ts";
import {
  execute,
  epochsBelow,
  positiveLimit,
  settled,
  type Attempt,
  type StorageContext,
} from "./context.ts";
import { indexPartitions, keys } from "./keys.ts";
import {
  adjustLedger,
  decodeAlertMembers,
  decodeDelivery,
  decodeDeliveryMeta,
  deliveryRecord,
  gateRecord,
  loaded,
  ledgerRecord,
  releaseSending,
  reserveSending,
} from "./records.ts";

function applyDeliveryPatch(delivery: Delivery, patch: DeliveryPatch): Delivery {
  return {
    ...delivery,
    ...(patch.attempts === undefined ? {} : { attempts: patch.attempts }),
    ...(patch.provider_message_id === undefined
      ? {}
      : { provider_message_id: patch.provider_message_id }),
    ...(patch.last_error === undefined
      ? {}
      : {
          last_error: patch.last_error === null ? null : summarizeDurableError(patch.last_error),
        }),
    ...(patch.next_attempt_at === undefined ? {} : { next_attempt_at: patch.next_attempt_at }),
    ...(patch.expires_at === undefined ? {} : { expires_at: patch.expires_at }),
    ...(patch.suppressed_reason === undefined
      ? {}
      : { suppressed_reason: patch.suppressed_reason }),
  };
}

export function createDeliveryRepo(context: StorageContext): DeliveryRepo {
  const { table, optimistic, commit, read, loadGate, loadLedger, staleRows } = context;

  const deliveries: DeliveryRepo = {
    async get(id): Promise<Delivery | null> {
      return execute(() => read(keys.delivery(id), decodeDelivery));
    },
    async listByAlert(alertId): Promise<readonly Delivery[]> {
      return execute(async () => {
        const row = await table.get(keys.alert(alertId));
        if (row === null) return [];
        const { deliveryIds } = decodeAlertMembers(row);
        const rows = await Promise.all(
          deliveryIds.map((id) => read(keys.delivery(id), decodeDelivery)),
        );
        return rows
          .flatMap((delivery) => (delivery === null ? [] : [delivery]))
          .toSorted((left, right) => compareId(left.id, right.id));
      });
    },
    async claimForSend(request): Promise<DeliverySendClaim> {
      const cutoff = sendIntervalCutoff(request);
      const { id, from, expected, at, maxUpdatesPerItem } = request;
      return execute(() =>
        optimistic(async (): Attempt<DeliverySendClaim> => {
          const row = await table.get(keys.delivery(id));
          if (row === null) return { kind: "unavailable" };
          const current = loaded(row, decodeDelivery);
          const meta = decodeDeliveryMeta(row);
          const delivery = current.value;
          if (
            delivery.state !== from ||
            (delivery.state !== "pending" && delivery.state !== "failed_retryable") ||
            !matchesVersion(delivery, expected) ||
            delivery.dry_run ||
            delivery.expires_at <= at ||
            delivery.state_updated_at > at ||
            (delivery.next_attempt_at !== null && delivery.next_attempt_at > at)
          ) {
            return { kind: "unavailable" };
          }

          const isUpdate = meta.alertKind === "update";
          const [gate, ledger] = await Promise.all([
            loadGate(),
            isUpdate ? loadLedger(meta.itemId) : null,
          ]);
          let reason: "update_limit" | "rate_limit" | null = null;
          if (ledger !== null) {
            const predecessors = [...ledger.alerts.keys()].filter(
              (alertId) => alertId !== delivery.alert_id,
            ).length;
            if (predecessors >= maxUpdatesPerItem) reason = "update_limit";
          }
          if (reason === null && cutoff !== null) {
            const sendingElsewhere = [...gate.sending.values()].some(
              (alertId) => alertId !== delivery.alert_id,
            );
            const latestElsewhere = gate.recent.find(
              (entry) => entry.alert_id !== delivery.alert_id,
            );
            if (
              sendingElsewhere ||
              (latestElsewhere !== undefined && latestElsewhere.at > cutoff)
            ) {
              reason = "rate_limit";
            }
          }

          const deliveryWrite = (next: Delivery, live: boolean): WriteOp => ({
            kind: "put",
            item: deliveryRecord(next, { ...meta, live }, current.rev + 1),
            condition: revCondition(current.rev),
          });

          if (reason !== null) {
            // `rate_limit` holds the row in its state, later by one interval in both
            // `next_attempt_at` and `expires_at`; `update_limit` is terminal.
            const deferMs = request.minIntervalMinutes * 60_000;
            const settledRow: Delivery =
              reason === "rate_limit"
                ? {
                    ...delivery,
                    state_updated_at: at,
                    next_attempt_at: at + deferMs,
                    expires_at: delivery.expires_at + deferMs,
                  }
                : {
                    ...delivery,
                    state: "suppressed",
                    state_updated_at: at,
                    next_attempt_at: null,
                    suppressed_reason: reason,
                  };
            // The decision read the gate and ledger, so the write commits only if neither moved.
            const operations: WriteOp[] = [deliveryWrite(settledRow, false)];
            if (reason === "rate_limit") {
              operations.push({
                kind: "check",
                key: keys.sendGate,
                condition: revCondition(gate.rev),
              });
            }
            if (ledger !== null) {
              operations.push({
                kind: "check",
                key: keys.updateLedger(meta.itemId),
                condition: revCondition(ledger.rev),
              });
            }
            return settled(
              await commit(operations),
              reason === "rate_limit"
                ? { kind: "deferred", until: at + deferMs }
                : { kind: "suppressed", reason },
            );
          }

          const claimed: Delivery = {
            ...delivery,
            state: "sending",
            state_updated_at: at,
            next_attempt_at: null,
            suppressed_reason: null,
            attempts: delivery.attempts + 1,
          };
          const operations: WriteOp[] = [
            deliveryWrite(claimed, true),
            {
              kind: "put",
              item: gateRecord(reserveSending(gate, delivery.id, delivery.alert_id)),
              condition: revCondition(gate.rev),
            },
          ];
          if (ledger !== null) {
            operations.push({
              kind: "put",
              item: ledgerRecord(meta.itemId, adjustLedger(ledger, delivery.alert_id, 1)),
              condition: revCondition(ledger.rev),
            });
          }
          return settled(await commit(operations), { kind: "claimed", delivery: claimed });
        }),
      );
    },
    async transition(transition): Promise<boolean> {
      if (!isDeliveryTransitionAllowed(transition.from, transition.to)) return false;
      return execute(() =>
        optimistic(async () => {
          const row = await table.get(keys.delivery(transition.id));
          if (row === null) return false;
          const current = loaded(row, decodeDelivery);
          const meta = decodeDeliveryMeta(row);
          if (
            current.value.state !== transition.from ||
            !matchesVersion(current.value, transition.expected)
          ) {
            return false;
          }
          const next: Delivery = {
            ...applyDeliveryPatch(current.value, transition.patch ?? {}),
            state: transition.to,
            state_updated_at: transition.at,
          };
          // `sent` and `unknown` are terminal and keep the reservation; any other target releases it.
          const live = meta.live && (transition.to === "sent" || transition.to === "unknown");
          const operations: WriteOp[] = [
            {
              kind: "put",
              item: deliveryRecord(next, { ...meta, live }, current.rev + 1),
              condition: revCondition(current.rev),
            },
          ];
          if (meta.live) {
            const [gate, ledger] = await Promise.all([
              loadGate(),
              !live && meta.alertKind === "update" ? loadLedger(meta.itemId) : null,
            ]);
            operations.push({
              kind: "put",
              item: gateRecord(
                releaseSending(
                  gate,
                  next.id,
                  live ? { alert_id: next.alert_id, at: transition.at } : null,
                ),
              ),
              condition: revCondition(gate.rev),
            });
            if (ledger !== null) {
              operations.push({
                kind: "put",
                item: ledgerRecord(meta.itemId, adjustLedger(ledger, next.alert_id, -1)),
                condition: revCondition(ledger.rev),
              });
            }
          }
          return settled(await commit(operations), true);
        }),
      );
    },
    async listDue(now, limit): Promise<readonly Delivery[]> {
      const wanted = positiveLimit(limit);
      const below = epochsBelow(Math.floor(now) + 1);
      if (wanted <= 0 || below === null) return [];
      return execute(() =>
        table.collect(
          {
            index: "gsi2",
            partition: indexPartitions.deliveriesDue,
            range: { op: "<", value: below },
          },
          wanted,
          decodeDelivery,
        ),
      );
    },
    async listStale(query): Promise<readonly Delivery[]> {
      return staleRows(query, indexPartitions.deliveriesByState, decodeDelivery);
    },
  };

  return deliveries;
}

import type { Alert, Delivery } from "@ai-news-tracker/contracts/entities";
import {
  AlertFeedQuerySchema,
  type AlertRepo,
  type Inserted,
} from "@ai-news-tracker/contracts/ports/storage";
import { parseBoundary } from "@ai-news-tracker/kernel/boundary";
import { AppError, summarizeDurableError } from "@ai-news-tracker/kernel/errors/app-error";
import { compareId, validateAlertDocuments } from "@ai-news-tracker/storage/rules";

import { ABSENT, revCondition, type WriteOp } from "./client.ts";
import { readString } from "./codec.ts";
import { execute, inserted, settled, requireNoConflict, type StorageContext } from "./context.ts";
import { indexPartitions, keys, timeKey, uniqueKey } from "./keys.ts";
import {
  alertDocumentRecord,
  alertRecord,
  decodeAlert,
  decodeAlertDocument,
  decodeAlertMembers,
  deliveryRecord,
  itemAlertRecord,
  loaded,
  markerRecord,
} from "./records.ts";

function storedDelivery(delivery: Delivery): Delivery {
  return {
    id: delivery.id,
    alert_id: delivery.alert_id,
    destination_id: delivery.destination_id,
    idempotency_key: delivery.idempotency_key,
    state: delivery.state,
    state_updated_at: delivery.state_updated_at,
    attempts: delivery.attempts,
    provider_message_id: delivery.provider_message_id,
    last_error: delivery.last_error === null ? null : summarizeDurableError(delivery.last_error),
    next_attempt_at: delivery.next_attempt_at,
    expires_at: delivery.expires_at,
    lang: delivery.lang,
    dry_run: delivery.dry_run,
    suppressed_reason: delivery.suppressed_reason,
    created_at: delivery.created_at,
  };
}

export function createAlertRepo(context: StorageContext): AlertRepo {
  const { table, optimistic, read, resolveMarker } = context;

  const alerts: AlertRepo = {
    async insertWithDeliveries(alert, deliveriesToInsert, documents): Promise<Inserted<Alert>> {
      return execute(async () => {
        const alertMarker = await uniqueKey("alert_key", alert.alert_key);
        const existing = await resolveMarker(alertMarker, keys.alert, decodeAlert);
        if (existing !== null) return inserted(existing.value, false);
        const validatedDocuments = validateAlertDocuments(alert, deliveriesToInsert, documents);

        const staged: Delivery[] = [];
        const idempotencyKeys = new Set<string>();
        const deliveryIds = new Set<string>();
        for (const delivery of deliveriesToInsert) {
          if (delivery.alert_id !== alert.id) throw new AppError("STATE_CONFLICT");
          if (idempotencyKeys.has(delivery.idempotency_key)) continue;
          if (deliveryIds.has(delivery.id)) throw new AppError("STATE_CONFLICT");
          idempotencyKeys.add(delivery.idempotency_key);
          deliveryIds.add(delivery.id);
          staged.push(delivery);
        }

        const members = {
          deliveryIds: staged.map((delivery) => delivery.id).toSorted(compareId),
          documentLangs: validatedDocuments.map((document) => document.lang),
        };
        const meta = { live: false, alertKind: alert.kind, itemId: alert.item_id };
        const operations: WriteOp[] = [
          { kind: "put", item: alertRecord(alert, members, 1), condition: ABSENT },
          { kind: "put", item: markerRecord(alertMarker, alert.id), condition: ABSENT },
          { kind: "put", item: itemAlertRecord(alert), condition: ABSENT },
          ...validatedDocuments.map((document): WriteOp => ({
            kind: "put",
            item: alertDocumentRecord(document),
          })),
        ];
        for (const delivery of staged) {
          const marker = await uniqueKey("delivery_idempotency_key", delivery.idempotency_key);
          operations.push(
            {
              kind: "put",
              item: deliveryRecord(storedDelivery(delivery), meta, 1),
              condition: ABSENT,
            },
            { kind: "put", item: markerRecord(marker, delivery.id), condition: ABSENT },
          );
        }
        // One transaction keeps a failed write from leaving the alert or any delivery visible.
        const outcome = await table.transact(operations);
        requireNoConflict(outcome, "TransactWriteItems");
        if (outcome.kind === "condition") {
          const replay = await resolveMarker(alertMarker, keys.alert, decodeAlert);
          if (replay !== null) return inserted(replay.value, false);
          // An id or a delivery idempotency key already belongs to another row: not a replay.
          throw new AppError("STATE_CONFLICT");
        }
        return inserted(alert, true);
      });
    },
    async get(id): Promise<Alert | null> {
      return execute(() => read(keys.alert(id), decodeAlert));
    },
    async getByKey(alertKey): Promise<Alert | null> {
      return execute(async () => {
        const marker = await uniqueKey("alert_key", alertKey);
        return (await resolveMarker(marker, keys.alert, decodeAlert))?.value ?? null;
      });
    },
    async replaceDocuments(id, documents): Promise<boolean> {
      return execute(() =>
        optimistic(async () => {
          const row = await table.get(keys.alert(id));
          if (row === null) return false;
          const current = loaded(row, decodeAlert);
          const members = decodeAlertMembers(row);
          const validated = validateAlertDocuments(current.value, [], documents);
          const langs = new Set<string>(validated.map((document) => document.lang));
          const operations: WriteOp[] = [
            {
              kind: "put",
              item: alertRecord(
                current.value,
                { ...members, documentLangs: [...langs] },
                current.rev + 1,
              ),
              condition: revCondition(current.rev),
            },
            ...validated.map((document): WriteOp => ({
              kind: "put",
              item: alertDocumentRecord(document),
            })),
            ...members.documentLangs
              .filter((lang) => !langs.has(lang))
              .map((lang): WriteOp => ({
                kind: "delete",
                key: { pk: keys.alert(id).pk, sk: `DOC#${lang}` },
              })),
          ];
          return settled(await table.transact(operations), true);
        }),
      );
    },
    async getDocument(id, lang) {
      return execute(() => read(keys.alertDocument(id, lang), decodeAlertDocument));
    },
    async listFeed(query): Promise<readonly Alert[]> {
      const { before, limit, itemId } = parseBoundary(AlertFeedQuerySchema, query, "INPUT_INVALID");
      return execute(() => {
        if (itemId === undefined) {
          return table.collect(
            {
              index: "gsi1",
              partition: indexPartitions.alertFeed,
              descending: true,
              ...(before === undefined
                ? {}
                : { range: { op: "<", value: timeKey(before.at, before.id) } }),
            },
            limit,
            decodeAlert,
          );
        }
        const prefix = keys.itemAlertPrefix;
        const cursor = before === undefined ? null : `${prefix}${timeKey(before.at, before.id)}`;
        return table.collect(
          {
            partition: keys.itemPartition(itemId),
            descending: true,
            range:
              cursor === null
                ? { op: "begins_with", value: prefix }
                : { op: "between", value: prefix, upper: cursor },
          },
          limit,
          (row) => (readString(row, "sk") === cursor ? null : decodeAlert(row)),
          limit + 1,
        );
      });
    },
  };

  return alerts;
}

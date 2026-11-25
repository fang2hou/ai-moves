import { AppConfigSchema } from "@ai-moves/contracts/config";
import type { AuditLogEntry, ConfigVersion, Destination } from "@ai-moves/contracts/entities";
import {
  AdminChangeSchema,
  DestinationPatchSchema,
  DestinationSummarySchema,
  StorageLimitSchema,
  type AdminRepo,
  type AuditLog,
  type ConfigStore,
  type DestinationRepo,
  type DestinationSummary,
  type Inserted,
} from "@ai-moves/contracts/ports/storage";
import { JsonObjectSchema, type JsonObject } from "@ai-moves/contracts/primitives";
import { parseBoundary } from "@ai-moves/kernel/boundary";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import { ABSENT, EXISTS, revCondition } from "./client.ts";
import { type Attributes, decodeDoc, readString } from "./codec.ts";
import {
  execute,
  inserted,
  compareCreated,
  settled,
  requireNoConflict,
  RETRY,
  type StorageContext,
} from "./context.ts";
import { indexPartitions, keys, uniqueKey } from "./keys.ts";
import {
  auditRecord,
  configRecord,
  decodeAudit,
  decodeConfig,
  decodeDestination,
  destinationRecord,
} from "./records.ts";

function configVersionOf(attributes: Attributes): number {
  const version = Number(readString(attributes, "sk"));
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AppError("ROW_INVALID", {
      message: "Invalid stored config version key",
      context: { entity: "config_versions" },
    });
  }
  return version;
}

function jsonObject(value: unknown): JsonObject {
  return parseBoundary(JsonObjectSchema, JSON.parse(JSON.stringify(value)), "INPUT_INVALID");
}

export function createAdminRepos(context: StorageContext) {
  const { table, optimistic, load, read, queryAll, resolveMarker, insertUnique } = context;

  const destinations: DestinationRepo = {
    async upsert(destination): Promise<Inserted<Destination>> {
      return execute(async () => {
        const marker = await uniqueKey("destination_name", destination.name);
        const existing = await resolveMarker(marker, keys.destination, decodeDestination);
        if (existing !== null) return inserted(existing.value, false);
        const outcome = await insertUnique(
          destinationRecord(destination, 1),
          marker,
          destination.id,
        );
        requireNoConflict(outcome, "TransactWriteItems");
        if (outcome.kind === "condition") {
          const replay = await resolveMarker(marker, keys.destination, decodeDestination);
          if (replay !== null) return inserted(replay.value, false);
          throw new AppError("STATE_CONFLICT");
        }
        return inserted(destination, true);
      });
    },
    async get(id): Promise<Destination | null> {
      return execute(() => read(keys.destination(id), decodeDestination));
    },
    async list(): Promise<readonly Destination[]> {
      return execute(async () =>
        (await queryAll({ partition: keys.destinationPartition }, decodeDestination)).toSorted(
          compareCreated,
        ),
      );
    },
  };
  const audit: AuditLog = {
    async append(entry): Promise<void> {
      await execute(async () => {
        requireNoConflict(await table.put(auditRecord(entry), ABSENT), "PutItem");
      });
    },
    async listRecent(limit): Promise<readonly AuditLogEntry[]> {
      const bounded = parseBoundary(StorageLimitSchema, limit, "INPUT_INVALID");
      return execute(() =>
        table.collect(
          { index: "gsi1", partition: indexPartitions.auditLog, descending: true },
          bounded,
          decodeAudit,
        ),
      );
    },
  };
  async function latestConfig(): Promise<Attributes | null> {
    const [latest] = await table.collect(
      { partition: keys.configPartition, descending: true },
      1,
      (row) => row,
    );
    return latest ?? null;
  }
  const config: ConfigStore = {
    async getCurrent(): Promise<ConfigVersion | null> {
      return execute(async () => {
        const latest = await latestConfig();
        return latest === null ? null : decodeConfig(latest);
      });
    },
    async publish(appConfig, actor, at): Promise<ConfigVersion> {
      return execute(() =>
        optimistic(async () => {
          const latest = await latestConfig();
          const version = latest === null ? 1 : configVersionOf(latest) + 1;
          const record = configRecord({
            version,
            config: appConfig,
            created_at: at,
            created_by: actor,
          });
          const outcome = await table.put(record, ABSENT);
          return outcome.kind === "ok" ? decodeConfig(record) : RETRY;
        }),
      );
    },
  };
  const admin: AdminRepo = {
    async listDestinations(): Promise<readonly DestinationSummary[]> {
      return execute(async () =>
        (
          await queryAll({ partition: keys.destinationPartition }, (row) =>
            decodeDoc(DestinationSummarySchema, row, "destinations"),
          )
        ).toSorted(compareCreated),
      );
    },
    async patchDestination(id, input, change): Promise<boolean> {
      parseBoundary(AdminChangeSchema, change, "INPUT_INVALID");
      const patch = parseBoundary(DestinationPatchSchema, input, "INPUT_INVALID");
      const { lang, enabled, dry_run, min_tier, source_filters, quiet_hours } = patch;
      return execute(() =>
        optimistic(async () => {
          const current = await load(keys.destination(id), decodeDestination);
          if (current === null) return false;
          const row = current.value;
          const next: Destination = {
            ...row,
            lang: lang ?? row.lang,
            enabled: enabled ?? row.enabled,
            dry_run: dry_run ?? row.dry_run,
            min_tier: min_tier ?? row.min_tier,
            source_filters: source_filters ?? row.source_filters,
            quiet_hours: quiet_hours === undefined ? row.quiet_hours : quiet_hours,
            updated_at: change.at,
          };
          const entry: AuditLogEntry = {
            id: change.id,
            actor: change.actor,
            action: "destination.patch",
            target: `destination:${id}`,
            detail_json: jsonObject(patch),
            created_at: change.at,
          };
          const outcome = await table.transact([
            {
              kind: "put",
              item: destinationRecord(next, current.rev + 1),
              condition: revCondition(current.rev),
            },
            { kind: "put", item: auditRecord(entry), condition: ABSENT },
          ]);
          // A taken audit id means this change was already applied: report it as not applied.
          if (outcome.kind === "condition" && outcome.failed.includes(1)) return false;
          return settled(outcome, true);
        }),
      );
    },
    async publishConfig(appConfig, expectedVersion, change): Promise<ConfigVersion | null> {
      parseBoundary(AdminChangeSchema, change, "INPUT_INVALID");
      const validated = parseBoundary(AppConfigSchema, appConfig, "CONFIG_INVALID");
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return null;
      return execute(async () => {
        const version = expectedVersion + 1;
        const record = configRecord({
          version,
          config: validated,
          created_at: change.at,
          created_by: change.actor,
        });
        const entry: AuditLogEntry = {
          id: change.id,
          actor: change.actor,
          action: "config.publish",
          target: `config:${version}`,
          detail_json: { previous: expectedVersion },
          created_at: change.at,
        };
        // Versions are contiguous, so "`expectedVersion` exists and its successor does not" is the
        // SQL predicate `expectedVersion = MAX(version)`.
        const outcome = await table.transact([
          { kind: "put", item: auditRecord(entry), condition: ABSENT },
          { kind: "put", item: record, condition: ABSENT },
          ...(expectedVersion === 0
            ? []
            : [{ kind: "check", key: keys.config(expectedVersion), condition: EXISTS } as const]),
        ]);
        requireNoConflict(outcome, "TransactWriteItems");
        return outcome.kind === "ok" ? decodeConfig(record) : null;
      });
    },
  };

  return { destinations, audit, config, admin };
}

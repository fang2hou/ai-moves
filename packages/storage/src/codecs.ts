import { AlertDocSchema, type AlertDoc } from "@ai-moves/contracts/alert-doc";
import type {
  Alert,
  Analysis,
  AuditLogEntry,
  BudgetLedgerEntry,
  ConfigVersion,
  Delivery,
  Destination,
  Item,
  ItemRevision,
  ItemSnapshot,
  Source,
} from "@ai-moves/contracts/entities";
import {
  DestinationSummarySchema,
  type DestinationSummary,
} from "@ai-moves/contracts/ports/storage";
import {
  AlertSchema,
  AnalysisSchema,
  AuditLogEntrySchema,
  BudgetLedgerEntrySchema,
  ConfigVersionSchema,
  DeliverySchema,
  DestinationSchema,
  ItemRevisionSchema,
  ItemSchema,
  ItemSnapshotSchema,
  SourceSchema,
} from "@ai-moves/contracts/entities";
import { AppError } from "@ai-moves/kernel/errors/app-error";

type ZodDecoder<T> = { parse(value: unknown): T };
const AlertDocumentsSchema = AlertDocSchema.array().max(3);

function decode<T>(schema: ZodDecoder<T>, value: unknown, table: string): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new AppError("ROW_INVALID", {
      message: `Invalid stored row in ${table}`,
      cause,
      context: { table },
    });
  }
}

function parseJson(value: unknown, table: string, field: string): unknown {
  if (typeof value !== "string") {
    throw new AppError("ROW_INVALID", {
      message: `Invalid stored JSON in ${table}.${field}`,
      context: { table, field },
    });
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new AppError("ROW_INVALID", {
      message: `Invalid stored JSON in ${table}.${field}`,
      cause,
      context: { table, field },
    });
  }
}

function parseNullableJson(value: unknown, table: string, field: string): unknown {
  return value === null ? null : parseJson(value, table, field);
}

function booleanFromInteger(value: unknown, table: string, field: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new AppError("ROW_INVALID", {
    message: `Invalid stored boolean in ${table}.${field}`,
    context: { table, field },
  });
}

export function decodeSource(row: Record<string, unknown>): Source {
  return decode(
    SourceSchema,
    {
      ...row,
      config_json: parseJson(row["config_json"], "sources", "config_json"),
      cursor_json: parseJson(row["cursor_json"], "sources", "cursor_json"),
    },
    "sources",
  );
}

export function decodeItem(row: Record<string, unknown>): Item {
  return decode(
    ItemSchema,
    {
      ...row,
      score_json: parseNullableJson(row["score_json"], "items", "score_json"),
    },
    "items",
  );
}

export function decodeItemSnapshot(row: Record<string, unknown>): ItemSnapshot {
  return decode(ItemSnapshotSchema, row, "item_snapshots");
}

export function decodeItemRevision(row: Record<string, unknown>): ItemRevision {
  return decode(ItemRevisionSchema, row, "item_revisions");
}

export function decodeAnalysis(row: Record<string, unknown>): Analysis {
  return decode(
    AnalysisSchema,
    {
      ...row,
      output_json: parseNullableJson(row["output_json"], "analyses", "output_json"),
      usage_json: parseNullableJson(row["usage_json"], "analyses", "usage_json"),
    },
    "analyses",
  );
}

export function decodeAlert(row: Record<string, unknown>): Alert {
  return decode(
    AlertSchema,
    {
      ...row,
      decision_reason_json: parseJson(
        row["decision_reason_json"],
        "alerts",
        "decision_reason_json",
      ),
    },
    "alerts",
  );
}

export function decodeAlertDocuments(row: Record<string, unknown>): readonly AlertDoc[] {
  const documents = parseNullableJson(row["documents_json"], "alerts", "documents_json");
  return documents === null ? [] : decode(AlertDocumentsSchema, documents, "alerts");
}

export function decodeDelivery(row: Record<string, unknown>): Delivery {
  return decode(
    DeliverySchema,
    {
      ...row,
      dry_run: booleanFromInteger(row["dry_run"], "deliveries", "dry_run"),
      last_error: parseNullableJson(row["last_error_json"], "deliveries", "last_error_json"),
    },
    "deliveries",
  );
}

function destinationFields(row: Record<string, unknown>): unknown {
  return {
    ...row,
    enabled: booleanFromInteger(row["enabled"], "destinations", "enabled"),
    dry_run: booleanFromInteger(row["dry_run"], "destinations", "dry_run"),
    source_filters: parseJson(row["source_filters_json"], "destinations", "source_filters_json"),
    quiet_hours: parseNullableJson(row["quiet_hours_json"], "destinations", "quiet_hours_json"),
  };
}

export function decodeDestination(row: Record<string, unknown>): Destination {
  return decode(DestinationSchema, destinationFields(row), "destinations");
}

export function decodeDestinationSummary(row: Record<string, unknown>): DestinationSummary {
  return decode(DestinationSummarySchema, destinationFields(row), "destinations");
}

export function decodeBudgetLedgerEntry(row: Record<string, unknown>): BudgetLedgerEntry {
  return decode(
    BudgetLedgerEntrySchema,
    {
      day: row["day"],
      scope: row["scope"],
      used: row["used"],
      limit: row["limit_value"],
    },
    "budget_ledger",
  );
}

export function decodeConfigVersion(row: Record<string, unknown>): ConfigVersion {
  return decode(
    ConfigVersionSchema,
    {
      version: row["version"],
      config: parseJson(row["config_json"], "config_versions", "config_json"),
      created_at: row["created_at"],
      created_by: row["created_by"],
    },
    "config_versions",
  );
}

export function decodeAuditLogEntry(row: Record<string, unknown>): AuditLogEntry {
  return decode(
    AuditLogEntrySchema,
    {
      ...row,
      detail_json: parseJson(row["detail_json"], "audit_log", "detail_json"),
    },
    "audit_log",
  );
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function nullableJson(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

export function integer(value: boolean): number {
  return value ? 1 : 0;
}

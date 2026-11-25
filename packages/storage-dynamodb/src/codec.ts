import { AppError } from "@ai-moves/kernel/errors/app-error";

export type Scalar = string | number | boolean | null;
export type Attributes = Readonly<Record<string, Scalar>>;
type AttributeValue = { S: string } | { N: string } | { BOOL: boolean } | { NULL: true };

export const MAX_ITEM_BYTES = 400 * 1024;

const encoder = new TextEncoder();

function marshalValue(value: Scalar): AttributeValue {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "boolean") return { BOOL: value };
  if (!Number.isFinite(value))
    throw new AppError("INPUT_INVALID", { message: "Non-finite number" });
  return { N: String(value) };
}

export function marshal(attributes: Attributes): Record<string, AttributeValue> {
  const item: Record<string, AttributeValue> = {};
  for (const [name, value] of Object.entries(attributes)) item[name] = marshalValue(value);
  return item;
}

function rowInvalid(field: string): AppError {
  return new AppError("ROW_INVALID", {
    message: `Invalid stored attribute ${field}`,
    context: { field },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unmarshalValue(entry: unknown, field: string): Scalar {
  if (!isRecord(entry)) throw rowInvalid(field);
  if (typeof entry["S"] === "string") return entry["S"];
  if (typeof entry["N"] === "string") {
    const number = Number(entry["N"]);
    if (!Number.isFinite(number)) throw rowInvalid(field);
    return number;
  }
  if (typeof entry["BOOL"] === "boolean") return entry["BOOL"];
  if (entry["NULL"] === true) return null;
  throw rowInvalid(field);
}

export function unmarshal(item: unknown): Attributes {
  if (typeof item !== "object" || item === null) throw rowInvalid("(item)");
  const attributes: Record<string, Scalar> = {};
  for (const [name, value] of Object.entries(item)) attributes[name] = unmarshalValue(value, name);
  return attributes;
}

// An approximation of DynamoDB's item size accounting (attribute names plus values), checked
// before a write so an oversized record fails as a caller error instead of a retried 400.
export function itemBytes(attributes: Attributes): number {
  let total = 0;
  for (const [name, value] of Object.entries(attributes)) {
    total += encoder.encode(name).length;
    if (typeof value === "string") total += encoder.encode(value).length;
    else if (typeof value === "number") total += 21;
    else total += 1;
  }
  return total;
}

export function readString(attributes: Attributes, field: string): string {
  const value = attributes[field];
  if (typeof value !== "string") throw rowInvalid(field);
  return value;
}

export function readNullableString(attributes: Attributes, field: string): string | null {
  const value = attributes[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw rowInvalid(field);
  return value;
}

export function readNumber(attributes: Attributes, field: string): number {
  const value = attributes[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw rowInvalid(field);
  return value;
}

export function readNullableNumber(attributes: Attributes, field: string): number | null {
  const value = attributes[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw rowInvalid(field);
  return value;
}

export function readBoolean(attributes: Attributes, field: string): boolean {
  const value = attributes[field];
  if (typeof value !== "boolean") throw rowInvalid(field);
  return value;
}

export function readJson(attributes: Attributes, field: string, entity: string): unknown {
  const text = attributes[field];
  if (typeof text !== "string") {
    throw new AppError("ROW_INVALID", {
      message: `Invalid stored JSON in ${entity}.${field}`,
      context: { entity, field },
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new AppError("ROW_INVALID", {
      message: `Invalid stored JSON in ${entity}.${field}`,
      cause,
      context: { entity, field },
    });
  }
}

type ZodDecoder<T> = { parse(value: unknown): T };

export function decodeWith<T>(schema: ZodDecoder<T>, value: unknown, entity: string): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new AppError("ROW_INVALID", {
      message: `Invalid stored record in ${entity}`,
      cause,
      context: { entity },
    });
  }
}

export function decodeDoc<T>(schema: ZodDecoder<T>, attributes: Attributes, entity: string): T {
  return decodeWith(schema, readJson(attributes, "doc", entity), entity);
}

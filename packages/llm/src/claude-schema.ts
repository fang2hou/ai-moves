import { AppError } from "@ai-news-tracker/kernel/errors/app-error";
import { z } from "zod";

// Claude structured outputs reject these keywords with a 400. They are moved into the node's
// description so the model still sees them, and the caller's zod schema enforces them locally.
const CONSTRAINT_KEYWORDS = [
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "minItems",
] as const;

// Every keyword the transformed schema may still carry.
export const CLAUDE_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "allOf",
  "$ref",
  "$defs",
  "definitions",
  "default",
  "description",
  "title",
  "format",
  "pattern",
  "minItems",
]);

type JsonNode = Record<string, unknown>;

function isNode(value: unknown): value is JsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeConstraints(node: JsonNode, moved: readonly string[]): void {
  if (moved.length === 0) return;
  const note = `Constraints: ${moved.join(", ")}.`;
  const description = node["description"];
  node["description"] = typeof description === "string" ? `${description} ${note}` : note;
}

function transformNode(input: JsonNode): JsonNode {
  const node: JsonNode = {};
  const moved: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === "minItems" && (value === 0 || value === 1)) {
      node[key] = value;
    } else if ((CONSTRAINT_KEYWORDS as readonly string[]).includes(key)) {
      moved.push(`${key} ${JSON.stringify(value)}`);
    } else if (key === "oneOf") {
      node["anyOf"] = transformValue(value);
    } else if (key === "properties" || key === "$defs" || key === "definitions") {
      node[key] = isNode(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, child]) => [name, transformValue(child)]),
          )
        : value;
    } else {
      node[key] = transformValue(value);
    }
  }
  if (node["type"] === "object" || isNode(node["properties"])) {
    node["additionalProperties"] = false;
  }
  describeConstraints(node, moved);
  return node;
}

function transformValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(transformValue);
  return isNode(value) ? transformNode(value) : value;
}

// Converts a zod schema to the JSON Schema subset Claude structured outputs accept.
export function claudeJsonSchema(schema: z.ZodType): JsonNode {
  const raw = z.toJSONSchema(schema, { io: "input" });
  const { $schema: _dialect, ...body } = raw;
  const transformed = transformNode(body);
  const issue = unsupportedKeyword(transformed);
  if (issue !== undefined) {
    throw new AppError("CONFIG_INVALID", {
      message: `Schema keyword ${issue} is not accepted by Claude structured outputs`,
    });
  }
  return transformed;
}

// Returns the first keyword outside the accepted subset, so a schema the API would reject fails
// before any request is made.
export function unsupportedKeyword(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const issue = unsupportedKeyword(entry);
      if (issue !== undefined) return issue;
    }
    return undefined;
  }
  if (!isNode(node)) return undefined;
  if ("anyOf" in node && ("type" in node || "properties" in node)) return "anyOf beside type";
  for (const [key, value] of Object.entries(node)) {
    if (!CLAUDE_SCHEMA_KEYWORDS.has(key)) return key;
    if (key === "properties" || key === "$defs" || key === "definitions") {
      if (isNode(value)) {
        for (const child of Object.values(value)) {
          const issue = unsupportedKeyword(child);
          if (issue !== undefined) return issue;
        }
      }
    } else if (key !== "enum" && key !== "const" && key !== "default") {
      const issue = unsupportedKeyword(value);
      if (issue !== undefined) return issue;
    }
  }
  return undefined;
}

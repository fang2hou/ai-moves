import { StorageLimitSchema } from "@ai-news-tracker/contracts/ports/storage";
import { EntityIdSchema } from "@ai-news-tracker/contracts/primitives";
import { SubmitterSchema, type Submitter } from "@ai-news-tracker/contracts/scoring";
import {
  MAX_SUBMISSION_BODY_CHARS,
  SubmissionInputSchema,
} from "@ai-news-tracker/contracts/submission";
import { submissionDetailUrl } from "@ai-news-tracker/ingestion/submission";
import { parseBoundary } from "@ai-news-tracker/kernel/boundary";
import { AppError, isAppError } from "@ai-news-tracker/kernel/errors/app-error";
import { createLogger, type Logger } from "@ai-news-tracker/kernel/logger";

import {
  codeOnlyError,
  type Pipeline,
  type PipelineDeployment,
  type RuntimePorts,
} from "./pipeline.ts";

// Newest first. The endpoint keeps no session, so a client's version is only echoed back.
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;
// A 40,000 character body can take up to four bytes per character before JSON escaping.
const MAX_REQUEST_BYTES = 512 * 1024;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const MARKDOWN_RULES = [
  "Write `body` as markdown that follows these rules:",
  "1. A faithful excerpt of the source, in the source's original language. Do not translate, summarize, or rewrite it.",
  "2. Keep the author's handle and the post date exactly as the source shows them.",
  "3. Add no commentary, opinion, or instruction of your own.",
  "4. Link only to public pages. Never include a private, signed-in, or internal URL.",
].join("\n");

const MODE_RULES = [
  "Raw markdown is never posted: an analyzed item is published on the desk as a card written from the body.",
  "- `score` (the default): the AI reviewer scores the item first and may reject it, in which case nothing is published; `list_submissions` shows its score and comment. An item it passes is analyzed, published, and sent to chat channels unless a normal delivery check holds it back.",
  "- `publish`: skips the AI reviewer; the item is analyzed, published, and sent the same way. Use it only when the item should be posted regardless.",
].join("\n");

const INSTRUCTIONS = [
  "AI News Tracker turns a post, article, or announcement you read into an analyzed card on its public desk and in its chat channels.",
  "Use `submit_item` to send one, and `get_submission` to check how far it got. `list_submissions` shows every submission with the AI reviewer's verdict, `force_publish` posts one the reviewer rejected anyway, and `rereview_submission` asks the current reviewer to judge a rejected one again.",
  MARKDOWN_RULES,
  "`source_url` is the public https page the body came from. One item exists per URL, so submitting the same page again returns the existing item.",
  MODE_RULES,
  "The published card shows the submitter's display name.",
].join("\n\n");

const SUBMIT_ITEM_DESCRIPTION = [
  "Submit a source you read to AI News Tracker. It is analyzed and, if it qualifies, published as a card on the desk and in chat channels, with the submitter's display name shown publicly.",
  MARKDOWN_RULES,
  "`source_url` is the public https page the body came from; a second submission of the same page returns the existing item with created=false.",
  MODE_RULES,
].join("\n\n");

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

const LIST_SUBMISSIONS_DESCRIPTION = [
  "List submissions, newest first, with each one's submitter, pipeline state, the AI reviewer's decision, score and comment, the outcome of its alert once analysis finished, and whether it can be forced.",
  "A submission rejected before the AI reviewer existed shows the earlier triage reason as the comment, with a null score.",
].join("\n\n");

const FORCE_PUBLISH_DESCRIPTION = [
  "Post a submission regardless of the AI reviewer: it goes straight to deep analysis and, unless a normal delivery check holds it back, to chat channels.",
  "Accepted for items with can_force true: rejected by the reviewer, failed in analysis, or published to the desk without being sent. The item records who forced it, shown by the caller's display name.",
].join("\n\n");

const REREVIEW_DESCRIPTION =
  "Send a submission the AI reviewer rejected through the current reviewer again, for example after the review rules changed. Accepted for items with can_rereview true; the old review is replaced by the new one.";

// Written by hand because this package does not depend on zod. It mirrors SubmissionInputSchema,
// which stays the validator: a request that passes here but not there fails with INPUT_INVALID.
const TOOLS = [
  {
    name: "submit_item",
    description: SUBMIT_ITEM_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "source_url", "body"],
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description: "Title of the source.",
        },
        source_url: {
          type: "string",
          format: "uri",
          pattern: "^https://",
          maxLength: 2048,
          description: "Public https page the body was taken from.",
        },
        source_name: {
          type: ["string", "null"],
          minLength: 1,
          maxLength: 100,
          default: null,
          description:
            'Who published the source, as a reader would name them, e.g. "@karpathy on X".',
        },
        published_at: {
          type: ["integer", "null"],
          minimum: 0,
          default: null,
          description: "When the source was published, in milliseconds since the Unix epoch.",
        },
        body: {
          type: "string",
          minLength: 1,
          maxLength: MAX_SUBMISSION_BODY_CHARS,
          description:
            "Markdown excerpt of the source, following the rules in the tool description.",
        },
        mode: {
          type: "string",
          enum: ["score", "publish"],
          default: "score",
          description:
            "`score` lets the AI reviewer decide whether to publish; `publish` skips the reviewer.",
        },
      },
    },
  },
  {
    name: "get_submission",
    description:
      "Look up a submitted item by the item_id that submit_item returned: its pipeline state, the display name it was submitted under, and its desk URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["item_id"],
      properties: { item_id: { type: "string", minLength: 1, maxLength: 64 } },
    },
  },
  {
    name: "list_submissions",
    description: LIST_SUBMISSIONS_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          default: DEFAULT_LIST_LIMIT,
          description: "How many of the newest submissions to return.",
        },
      },
    },
  },
  {
    name: "force_publish",
    description: FORCE_PUBLISH_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["item_id"],
      properties: {
        item_id: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description: "The item_id of a submission whose can_force is true.",
        },
      },
    },
  },
  {
    name: "rereview_submission",
    description: REREVIEW_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["item_id"],
      properties: {
        item_id: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description: "The item_id of a submission whose can_rereview is true.",
        },
      },
    },
  },
] as const;

type JsonRpcId = string | number;

export interface McpHandlerOptions {
  readonly pipeline: Pick<
    Pipeline,
    "submit" | "listSubmissions" | "forceSubmission" | "rereviewSubmission"
  >;
  readonly deployment: PipelineDeployment;
  readonly runtime: RuntimePorts;
  // The verified identity behind the request, or null when there is none. A null result is a 401.
  readonly identify: (request: Request) => Submitter | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return reply({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcId | null, code: number, message: string, status = 200): Response {
  return reply({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function toolResult(structured: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function toolFailure(text: string): unknown {
  return { isError: true, content: [{ type: "text", text }] };
}

// Builds the stateless MCP endpoint: one JSON-RPC message per POST, answered as JSON. The caller
// checks nothing but the transport; who may submit is decided by `identify`.
export function createMcpHandler(
  options: McpHandlerOptions,
): (request: Request) => Promise<Response> {
  const { pipeline, deployment, runtime, identify } = options;
  const logger: Logger = createLogger({
    telemetry: runtime.telemetry,
    clock: runtime.clock,
    component: "mcp",
    level: deployment.settings.LOG_LEVEL,
  });

  async function callTool(params: Record<string, unknown>, submitter: Submitter, id: JsonRpcId) {
    const args = params["arguments"] ?? {};
    try {
      switch (params["name"]) {
        case "submit_item": {
          const input = parseBoundary(SubmissionInputSchema, args, "INPUT_INVALID");
          return rpcResult(id, toolResult(await pipeline.submit(input, submitter, deployment)));
        }
        case "list_submissions": {
          const limit = StorageLimitSchema.optional().safeParse(
            isRecord(args) ? args["limit"] : undefined,
          );
          if (!limit.success) {
            throw new AppError("INPUT_INVALID", { message: "INPUT_INVALID: limit (invalid)" });
          }
          return rpcResult(
            id,
            toolResult(await pipeline.listSubmissions({ limit: limit.data }, deployment)),
          );
        }
        case "force_publish": {
          const parsed = EntityIdSchema.safeParse(isRecord(args) ? args["item_id"] : undefined);
          if (!parsed.success) {
            throw new AppError("INPUT_INVALID", { message: "INPUT_INVALID: item_id (invalid)" });
          }
          return rpcResult(
            id,
            toolResult(await pipeline.forceSubmission(parsed.data, submitter, deployment)),
          );
        }
        case "rereview_submission": {
          const parsed = EntityIdSchema.safeParse(isRecord(args) ? args["item_id"] : undefined);
          if (!parsed.success) {
            throw new AppError("INPUT_INVALID", { message: "INPUT_INVALID: item_id (invalid)" });
          }
          return rpcResult(
            id,
            toolResult(await pipeline.rereviewSubmission(parsed.data, deployment)),
          );
        }
        case "get_submission": {
          const itemId = isRecord(args) ? args["item_id"] : undefined;
          const parsed = EntityIdSchema.safeParse(itemId);
          if (!parsed.success) {
            throw new AppError("INPUT_INVALID", { message: "INPUT_INVALID: item_id (invalid)" });
          }
          const item = await deployment.storage.items.get(parsed.data);
          if (item === null || item.kind !== "submission") throw new AppError("NOT_FOUND");
          return rpcResult(
            id,
            toolResult({
              item_id: item.id,
              state: item.state,
              submitted_by:
                item.score_json?.kind === "submission" ? item.score_json.submitter.name : null,
              detail_url: submissionDetailUrl(deployment.deskOrigin, item.id),
            }),
          );
        }
        default:
          return rpcError(id, INVALID_PARAMS, "Unknown tool");
      }
    } catch (cause) {
      const error = isAppError(cause) ? cause : codeOnlyError(cause);
      // Only a rejected input or lookup explains itself; any other failure names its code alone,
      // so no payload or provider detail reaches the client.
      if (error.code === "INPUT_INVALID" || error.code === "NOT_FOUND") {
        return rpcResult(id, toolFailure(error.message));
      }
      logger.error("mcp.tool_failed", { err: error, attrs: { tool: String(params["name"]) } });
      return rpcResult(id, toolFailure(`Request failed: ${error.code}`));
    }
  }

  return async (request) => {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    }
    const submitter = SubmitterSchema.safeParse(identify(request));
    if (!submitter.success) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    const text = declared > MAX_REQUEST_BYTES ? null : await request.text();
    if (text === null || text.length > MAX_REQUEST_BYTES) {
      return rpcError(null, INVALID_REQUEST, "Request too large", 413);
    }

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return rpcError(null, PARSE_ERROR, "Parse error", 400);
    }
    if (!isRecord(message) || message["jsonrpc"] !== "2.0") {
      // Batches are not part of the supported protocol versions.
      return rpcError(null, INVALID_REQUEST, "Expected one JSON-RPC 2.0 message", 400);
    }
    const method = message["method"];
    if (typeof method !== "string") {
      // A client's answer to a server request; the endpoint never sends any.
      return "result" in message || "error" in message
        ? new Response(null, { status: 202 })
        : rpcError(null, INVALID_REQUEST, "Missing method", 400);
    }
    const id = message["id"];
    if (id === undefined) return new Response(null, { status: 202 });
    if (typeof id !== "string" && typeof id !== "number") {
      return rpcError(null, INVALID_REQUEST, "Invalid request id", 400);
    }
    const params = isRecord(message["params"]) ? message["params"] : {};

    switch (method) {
      case "initialize": {
        const asked = params["protocolVersion"];
        const protocolVersion =
          PROTOCOL_VERSIONS.find((version) => version === asked) ?? PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "ai-news-tracker", version: "0.1.0" },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call":
        return callTool(params, submitter.data, id);
      default:
        return rpcError(id, METHOD_NOT_FOUND, "Method not found");
    }
  };
}

import {
  SubmissionListSchema,
  SubmissionSummarySchema,
  type SubmissionList,
  type SubmissionSummary,
} from "@ai-news-tracker/contracts/submission";
import type { SubmissionsErrorCode } from "@ai-news-tracker/locales/types";
import { z } from "zod";

type Transport = (path: string, init: RequestInit) => Promise<Response>;
export type CallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: SubmissionsErrorCode };

const reply = z.object({
  // A refusing tool returns `isError` with text content only, so the structured payload is optional
  // here and checked after `isError`.
  result: z
    .object({ structuredContent: z.unknown().optional(), isError: z.boolean().optional() })
    .optional(),
  error: z.unknown().optional(),
});

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface SubmissionsApi {
  list(): Promise<CallResult<SubmissionList>>;
  force(itemId: string): Promise<CallResult<SubmissionSummary>>;
  rereview(itemId: string): Promise<CallResult<SubmissionSummary>>;
}

// Talks to the deployment's MCP endpoint with JSON-RPC `tools/call`. The endpoint sits behind the
// deployment's sign-in, so a 401 or a reply that is not JSON (a sign-in page) means "sign in".
export function createSubmissionsApi(path: string, transport: Transport): SubmissionsApi {
  let nextId = 1;

  async function call<S extends z.ZodType>(
    name: string,
    args: Readonly<Record<string, unknown>>,
    schema: S,
  ): Promise<CallResult<z.output<S>>> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    try {
      const response = await transport(path, {
        method: "POST",
        credentials: "same-origin",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          // CloudFront's origin access control signs the request and rejects a POST that does not
          // carry the hash of its exact body.
          "x-amz-content-sha256": await sha256Hex(body),
        },
        body,
      });
      if (response.status === 401 || response.type === "opaqueredirect") {
        return { ok: false, code: "SIGN_IN" };
      }
      if (!response.headers.get("Content-Type")?.startsWith("application/json")) {
        return { ok: false, code: response.status >= 500 ? "UNAVAILABLE" : "SIGN_IN" };
      }
      const json: unknown = await response.json();
      if (!response.ok) return { ok: false, code: "UNAVAILABLE" };
      const parsed = reply.safeParse(json);
      if (!parsed.success) return { ok: false, code: "INVALID_RESPONSE" };
      if (parsed.data.result === undefined) return { ok: false, code: "UNAVAILABLE" };
      // A tool that refuses (an item no longer forceable) reports it as a result, not a transport error.
      if (parsed.data.result.isError === true) return { ok: false, code: "REJECTED" };
      const value = schema.safeParse(parsed.data.result.structuredContent);
      return value.success
        ? { ok: true, value: value.data }
        : { ok: false, code: "INVALID_RESPONSE" };
    } catch {
      return { ok: false, code: "UNAVAILABLE" };
    }
  }

  return {
    list: () => call("list_submissions", {}, SubmissionListSchema),
    force: (itemId) => call("force_publish", { item_id: itemId }, SubmissionSummarySchema),
    rereview: (itemId) => call("rereview_submission", { item_id: itemId }, SubmissionSummarySchema),
  };
}

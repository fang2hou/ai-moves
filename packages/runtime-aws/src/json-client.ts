import type { Clock, HttpFetch } from "@ai-moves/contracts/ports/runtime";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import { signRequest, type AwsCredentials } from "./sigv4.ts";

export type AwsCredentialSource = () => Promise<AwsCredentials>;

export interface AwsEndpoint {
  readonly region: string;
  readonly credentials: AwsCredentialSource;
  readonly fetch: HttpFetch;
  readonly clock: Clock;
  readonly timeoutMs: number;
  // Overrides the regional endpoint, for example a local emulator.
  readonly endpoint?: string | undefined;
}

// A response the service answered. `type` is the exception name without its namespace.
export type AwsJsonResult =
  | { readonly ok: true; readonly body: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly status: number;
      readonly type: string;
      readonly body: Readonly<Record<string, unknown>>;
    };

export interface AwsJsonClient {
  call(operation: string, input: Readonly<Record<string, unknown>>): Promise<AwsJsonResult>;
}

interface JsonProtocol {
  readonly service: string;
  readonly targetPrefix: string;
  readonly version: "1.0" | "1.1";
}

export const DYNAMODB_PROTOCOL: JsonProtocol = {
  service: "dynamodb",
  targetPrefix: "DynamoDB_20120810",
  version: "1.0",
};
export const SQS_PROTOCOL: JsonProtocol = {
  service: "sqs",
  targetPrefix: "AmazonSQS",
  version: "1.0",
};
export const SSM_PROTOCOL: JsonProtocol = {
  service: "ssm",
  targetPrefix: "AmazonSSM",
  version: "1.1",
};

function errorType(body: Readonly<Record<string, unknown>>, header: string | null): string {
  const raw = header ?? body["__type"] ?? body["code"];
  if (typeof raw !== "string") return "UnknownError";
  const name = raw.split(":")[0] ?? raw;
  return name.slice(name.lastIndexOf("#") + 1);
}

async function readBody(response: Response): Promise<Readonly<Record<string, unknown>>> {
  const text = await response.text();
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : {};
  } catch {
    return {};
  }
}

// One signed request per call, never retried here: callers own retry policy, and a transport
// failure rejects with UPSTREAM_UNAVAILABLE without saying whether the request was applied.
export function createAwsJsonClient(protocol: JsonProtocol, endpoint: AwsEndpoint): AwsJsonClient {
  const url = new URL(
    endpoint.endpoint ?? `https://${protocol.service}.${endpoint.region}.amazonaws.com/`,
  );
  return {
    async call(operation, input) {
      const body = new TextEncoder().encode(JSON.stringify(input));
      const headers = await signRequest(
        {
          method: "POST",
          url,
          headers: {
            "content-type": `application/x-amz-json-${protocol.version}`,
            "x-amz-target": `${protocol.targetPrefix}.${operation}`,
          },
          body,
        },
        {
          service: protocol.service,
          region: endpoint.region,
          credentials: await endpoint.credentials(),
          at: endpoint.clock.now(),
        },
      );
      let response: Response;
      let parsed: Readonly<Record<string, unknown>>;
      try {
        response = await endpoint.fetch(
          new Request(url, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(endpoint.timeoutMs),
          }),
        );
        parsed = await readBody(response);
      } catch (cause) {
        throw new AppError("UPSTREAM_UNAVAILABLE", {
          message: `UPSTREAM_UNAVAILABLE: ${protocol.service} ${operation} failed`,
          cause,
          context: { service: protocol.service, operation },
        });
      }
      if (response.ok) return { ok: true, body: parsed };
      return {
        ok: false,
        status: response.status,
        type: errorType(parsed, response.headers.get("x-amzn-errortype")),
        body: parsed,
      };
    },
  };
}

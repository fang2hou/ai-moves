import type { Clock, HttpFetch } from "@ai-moves/contracts/ports/runtime";

import type { AwsCredentialSource } from "./json-client.ts";
import { signRequest } from "./sigv4.ts";

export interface SignedFetchOptions {
  readonly service: string;
  readonly region: string;
  readonly credentials: AwsCredentialSource;
  readonly clock: Clock;
  readonly fetch: HttpFetch;
}

// Wraps fetch so every request is signed for one AWS service. Adapters that speak a provider's
// own HTTP API (for example Claude in Amazon Bedrock) take this as their transport and never see
// a credential. The request's headers are all signed, so callers send only what the API needs.
export function createSignedFetch(options: SignedFetchOptions): HttpFetch {
  return async (request) => {
    const body = new Uint8Array(await request.arrayBuffer());
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers) headers[name] = value;
    const url = new URL(request.url);
    const signed = await signRequest(
      { method: request.method, url, headers, body },
      {
        service: options.service,
        region: options.region,
        credentials: await options.credentials(),
        at: options.clock.now(),
      },
    );
    return options.fetch(
      new Request(url, {
        method: request.method,
        headers: signed,
        redirect: request.redirect,
        signal: request.signal,
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body }),
      }),
    );
  };
}

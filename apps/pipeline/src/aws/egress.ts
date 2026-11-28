/// <reference types="node" />
import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";

import type { HttpFetch } from "@ai-news-tracker/contracts/ports/runtime";
import { AppError } from "@ai-news-tracker/kernel/errors/app-error";

import type { PinnedEgress } from "../pipeline.ts";

const ADDRESS_LIMIT = 32;
const PINNED_TIMEOUT_MS = 15_000;

async function resolve(hostname: string): Promise<readonly string[]> {
  const answers = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses = answers
    .flatMap((answer) => (answer.status === "fulfilled" ? answer.value : []))
    .slice(0, ADDRESS_LIMIT);
  if (addresses.length === 0) {
    throw new AppError("UPSTREAM_UNAVAILABLE", { message: "DNS lookup failed" });
  }
  return addresses;
}

// Pull-based, so the socket is read only as fast as the web fetcher consumes the body.
function webStream(source: Readable): ReadableStream<Uint8Array> {
  const chunks = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next: IteratorResult<unknown> = await chunks.next();
      if (next.done === true) controller.close();
      else if (next.value instanceof Uint8Array) controller.enqueue(new Uint8Array(next.value));
    },
    cancel() {
      source.destroy();
    },
  });
}

// The web fetcher has already checked the address, so the socket must go to exactly that
// address: `host` pins the connection while `servername` and the Host header keep TLS
// verification and virtual hosting on the original name.
function fetchPinned(incoming: Request, address: string): Promise<Response> {
  const url = new URL(incoming.url);
  if (url.protocol !== "https:") {
    return Promise.reject(new AppError("SSRF_BLOCKED", { message: "Pinned fetch requires HTTPS" }));
  }
  const headers: Record<string, string> = { host: url.host };
  for (const [name, value] of incoming.headers) headers[name] = value;
  return new Promise((settle, reject) => {
    const outgoing = httpsRequest(
      {
        host: address,
        servername: url.hostname,
        port: url.port === "" ? 443 : Number(url.port),
        method: incoming.method,
        path: `${url.pathname}${url.search}`,
        headers,
        timeout: PINNED_TIMEOUT_MS,
        signal: incoming.signal,
      },
      (response) => {
        const status = response.statusCode ?? 502;
        const received = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === "string") received.set(name, value);
          else if (Array.isArray(value)) for (const entry of value) received.append(name, entry);
        }
        const empty = status === 204 || status === 304 || incoming.method === "HEAD";
        settle(new Response(empty ? null : webStream(response), { status, headers: received }));
      },
    );
    outgoing.on("timeout", () =>
      outgoing.destroy(new AppError("UPSTREAM_TIMEOUT", { message: "Pinned request timed out" })),
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

// Node resolves names itself and can open a socket to a chosen address, so unlike a Worker the
// Lambda entry enforces the SSRF pin rather than relying on the platform.
export function nodeEgress(): {
  readonly providerHttp: { fetch: HttpFetch };
  readonly pinnedWeb: PinnedEgress;
} {
  return {
    providerHttp: { fetch: (request) => fetch(request) },
    pinnedWeb: { resolve, fetchPinned },
  };
}

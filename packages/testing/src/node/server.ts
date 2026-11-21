import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { AppError } from "@ai-moves/kernel/errors/app-error";

import type { MockUpstream } from "../upstream/mock-upstream.ts";

export interface MockUpstreamServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface ListenOptions {
  readonly origin: string;
  readonly port?: number;
}

async function readBody(message: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of message) {
    if (chunk instanceof Uint8Array) chunks.push(chunk);
  }
  const body = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function toRequest(
  message: IncomingMessage,
  origin: string,
  signal: AbortSignal,
): Promise<Request> {
  const method = message.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (typeof value === "string" && name !== "host") headers.set(name, value);
  }
  const body = method === "GET" || method === "HEAD" ? null : await readBody(message);
  return new Request(new URL(message.url ?? "/", origin), { method, headers, body, signal });
}

async function handle(
  mock: MockUpstream,
  origin: string,
  message: IncomingMessage,
  reply: ServerResponse,
): Promise<void> {
  const disconnected = new AbortController();
  reply.on("close", () => disconnected.abort(new AppError("UPSTREAM_UNAVAILABLE")));
  try {
    const response = await mock.fetch(await toRequest(message, origin, disconnected.signal));
    reply.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    reply.end(new Uint8Array(await response.arrayBuffer()));
  } catch {
    reply.destroy();
  }
}

export function listenMockUpstream(
  mock: MockUpstream,
  options: ListenOptions,
): Promise<MockUpstreamServer> {
  const server = createServer((message, reply) => {
    void handle(mock, options.origin, message, reply);
  });
  const { promise, resolve, reject } = Promise.withResolvers<MockUpstreamServer>();
  server.once("error", reject);
  server.listen(options.port ?? 0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      reject(new AppError("INTERNAL", { message: "Mock upstream is not bound to a TCP port" }));
      return;
    }
    resolve({
      url: `http://127.0.0.1:${address.port}`,
      close: async () => {
        const closed = Promise.withResolvers<void>();
        server.closeAllConnections();
        server.close(() => closed.resolve());
        await closed.promise;
      },
    });
  });
  return promise;
}

import type { HttpFetch } from "@ai-moves/contracts/ports/runtime";

import type { RecordedExchange } from "../fixtures/exchange.ts";

// An in-process stand-in for an external HTTP service. Adapters receive `mock.fetch` in place of
// the platform fetch; `@ai-moves/testing/node` can also expose the same mock on a local port for
// end-to-end runs. Anything not scripted is an error, so a test cannot reach an upstream by
// accident (architecture 12.1).

export const MOCK_FAULTS = [
  "rate_limited",
  "server_error",
  "malformed_body",
  "timeout",
  "connection_error",
] as const;
export type MockFault = (typeof MOCK_FAULTS)[number];

export type RouteMatcher = string | RegExp | ((url: URL) => boolean);
export type Responder = (request: Request) => Promise<Response> | Response;

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FaultOptions {
  readonly times?: number;
  readonly retryAfterSeconds?: number;
}

export interface MockRoute {
  // Answers every matching request that no one-shot script claims.
  reply(status: number, body?: unknown, headers?: Readonly<Record<string, string>>): MockRoute;
  replyWith(responder: Responder): MockRoute;
  // Answers the next matching request only; scripts are consumed in the order they were added.
  replyOnce(status: number, body?: unknown, headers?: Readonly<Record<string, string>>): MockRoute;
  // Fails the next `times` matching requests (default 1) before any other script runs.
  failNext(fault: MockFault, options?: FaultOptions): MockRoute;
}

export interface MockUpstream {
  readonly fetch: HttpFetch;
  readonly requests: readonly RecordedRequest[];
  readonly unexpected: readonly RecordedRequest[];
  on(method: string, matcher: RouteMatcher): MockRoute;
  // Registers the request of a fixture and answers it with the fixture's response.
  replay(exchange: RecordedExchange): MockRoute;
  requestsTo(matcher: RouteMatcher): RecordedRequest[];
  // Number of one-shot scripts that were never consumed.
  pendingScripts(): number;
  reset(): void;
}

interface Route {
  readonly method: string;
  readonly matcher: RouteMatcher;
  readonly scripts: Responder[];
  fallback: Responder | undefined;
}

function matches(matcher: RouteMatcher, url: URL): boolean {
  if (typeof matcher === "string") {
    return url.href === matcher || `${url.origin}${url.pathname}` === matcher;
  }
  if (typeof matcher === "function") return matcher(url);
  matcher.lastIndex = 0;
  return matcher.test(url.href);
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  if (body === undefined || body === null) {
    return new Response(null, { status, headers });
  }
  if (typeof body === "string") {
    return new Response(body, { status, headers });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

const FAULT_RESPONDERS: Readonly<Record<MockFault, (options: FaultOptions) => Responder>> = {
  rate_limited: (options) => () =>
    jsonResponse(
      429,
      { error: "rate limited" },
      { "retry-after": String(options.retryAfterSeconds ?? 1) },
    ),
  server_error: () => () => jsonResponse(503, { error: "unavailable" }),
  malformed_body: () => () =>
    new Response('{"truncated": ', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  // Never answers. Settles only when the caller's deadline aborts the request.
  timeout: () => (request) => untilAborted(request.signal),
  // What fetch rejects with when no response was received.
  connection_error: () => () => Promise.reject(new TypeError("fetch failed")),
};

async function record(request: Request): Promise<RecordedRequest> {
  return {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
    body: await request.clone().text(),
  };
}

export function createMockUpstream(): MockUpstream {
  const routes: Route[] = [];
  const requests: RecordedRequest[] = [];
  const unexpected: RecordedRequest[] = [];

  const routeApi = (route: Route): MockRoute => {
    const api: MockRoute = {
      reply: (status, body, headers) => {
        route.fallback = () => jsonResponse(status, body, headers);
        return api;
      },
      replyWith: (responder) => {
        route.fallback = responder;
        return api;
      },
      replyOnce: (status, body, headers) => {
        route.scripts.push(() => jsonResponse(status, body, headers));
        return api;
      },
      failNext: (fault, options = {}) => {
        const responder = FAULT_RESPONDERS[fault](options);
        route.scripts.unshift(...Array.from({ length: options.times ?? 1 }, () => responder));
        return api;
      },
    };
    return api;
  };

  const on = (method: string, matcher: RouteMatcher): MockRoute => {
    const route: Route = {
      method: method.toUpperCase(),
      matcher,
      scripts: [],
      fallback: undefined,
    };
    routes.push(route);
    return routeApi(route);
  };

  return {
    requests,
    unexpected,
    on,
    replay: (exchange) =>
      on(exchange.request.method, exchange.request.url).reply(
        exchange.response.status,
        exchange.response.body,
        exchange.response.headers,
      ),
    fetch: async (request) => {
      const recorded = await record(request);
      const url = new URL(request.url);
      const candidates = routes.filter(
        (route) => route.method === request.method && matches(route.matcher, url),
      );
      const route =
        candidates.find((candidate) => candidate.scripts.length > 0) ??
        candidates.find((candidate) => candidate.fallback !== undefined);
      const responder = route?.scripts.shift() ?? route?.fallback;
      if (responder === undefined) {
        unexpected.push(recorded);
        throw new TypeError(`Unexpected upstream request: ${request.method} ${request.url}`);
      }
      requests.push(recorded);
      return responder(request);
    },
    requestsTo: (matcher) => requests.filter((request) => matches(matcher, new URL(request.url))),
    pendingScripts: () => routes.reduce((count, route) => count + route.scripts.length, 0),
    reset: () => {
      routes.length = 0;
      requests.length = 0;
      unexpected.length = 0;
    },
  };
}

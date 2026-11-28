import { AppError } from "@ai-news-tracker/kernel/errors/app-error";

import type { PipelineBindings } from "./bindings.ts";

// Outbound HTTP for a deployed Worker. The local runner supplies these two as plain
// object bindings; on Cloudflare there is no such binding type, so the module builds
// them from the platform's own fetch.
type Egress = Pick<PipelineBindings, "PROVIDER_HTTP" | "PINNED_WEB">;

const DOH = "https://cloudflare-dns.com/dns-query";
const ADDRESS_LIMIT = 32;

const DnsAnswer = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[\da-f:]+)$/iu;

// A DNS-over-HTTPS lookup, which is the only resolver a Worker has. The addresses
// go to the fetcher's own SSRF checks, the same as the local resolver's do.
async function resolve(hostname: string): Promise<readonly string[]> {
  const addresses: string[] = [];
  for (const type of ["A", "AAAA"]) {
    const url = new URL(DOH);
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    const response = await fetch(url, { headers: { accept: "application/dns-json" } });
    if (!response.ok) continue;
    const body: unknown = await response.json();
    const answers: unknown =
      typeof body === "object" && body !== null && "Answer" in body
        ? Reflect.get(body, "Answer")
        : null;
    if (!Array.isArray(answers)) continue;
    for (const answer of answers as readonly unknown[]) {
      const data: unknown =
        typeof answer === "object" && answer !== null ? Reflect.get(answer, "data") : null;
      if (typeof data === "string" && DnsAnswer.test(data)) addresses.push(data);
    }
  }
  if (addresses.length === 0)
    throw new AppError("UPSTREAM_UNAVAILABLE", { message: "DNS lookup failed" });
  return addresses.slice(0, ADDRESS_LIMIT);
}

// A Worker cannot open a socket to a chosen address, so the request goes out by
// hostname after the caller has checked where that hostname resolves. The runtime
// itself refuses to route to a private address, which is what the pinning defends
// against locally.
function fetchPinned(request: Request, _address: string): Promise<Response> {
  return fetch(request);
}

export function platformEgress(): Egress {
  return {
    PROVIDER_HTTP: { fetch: (request: Request) => fetch(request) },
    PINNED_WEB: { resolve, fetchPinned },
  };
}

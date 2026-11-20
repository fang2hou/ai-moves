import { WebFetchConfigSchema, type AppConfig } from "@ai-moves/contracts/config";
import type { WebDocument, WebFetcher } from "@ai-moves/contracts/ports/sources";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import { extractHtmlText } from "./html-text.ts";
import {
  checkManualResponse,
  discardBody,
  isRedirect,
  readText,
  redirectLocation,
  rejectStatus,
  USER_AGENT,
  withDeadline,
} from "./http.ts";
import { isIpLiteral, isPublicAddress } from "./public-address.ts";

export interface PinnedWebRequest {
  readonly request: Request;
  readonly address: string;
}

export interface WebFetcherOptions {
  readonly resolve: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  // Connect only to address, preserving the request host for TLS and HTTP. Never resolve again.
  readonly fetchPinned: (input: PinnedWebRequest) => Promise<Response>;
  readonly config?: Partial<AppConfig["web_fetch"]>;
  readonly timeoutMs?: number;
}

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;
const AUTHORITY_WITH_USERINFO = /^(?:https:)?\/\/[^/?#]*@/i;

function deniedDomain(domain: string): string {
  const parsed = URL.parse(`https://${domain}`);
  const hostname = parsed?.hostname.replace(/\.$/, "");
  if (hostname === undefined || !HOSTNAME.test(hostname) || /[/\\?#:@%\s]/u.test(domain)) {
    throw new AppError("CONFIG_INVALID", { message: "Invalid denied web domain" });
  }
  return hostname;
}

function hasUnsafeUrlCharacters(input: string): boolean {
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (code <= 32 || code === 127 || input[index] === "\\") {
      return true;
    }
  }
  return false;
}

function targetUrl(input: string, deniedDomains: readonly string[], base?: URL): URL {
  const url = URL.parse(input, base);
  if (
    url === null ||
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    AUTHORITY_WITH_USERINFO.test(input) ||
    hasUnsafeUrlCharacters(input)
  ) {
    throw new AppError("SSRF_BLOCKED", {
      message: "Web URL must be credential-free HTTPS on port 443",
    });
  }
  const hostname = url.hostname.replace(/\.$/, "");
  if (
    isIpLiteral(hostname) ||
    !HOSTNAME.test(hostname) ||
    deniedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
  ) {
    throw new AppError("SSRF_BLOCKED", { message: "Web hostname is not allowed" });
  }
  url.hostname = hostname;
  url.hash = "";
  if (url.href.length > 2_048) {
    throw new AppError("SSRF_BLOCKED", { message: "Web URL exceeds the supported length" });
  }
  return url;
}

async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let hash = "";
  for (const byte of new Uint8Array(digest)) {
    hash += byte.toString(16).padStart(2, "0");
  }
  return hash;
}

export function createWebFetcher(options: WebFetcherOptions): WebFetcher {
  const config = WebFetchConfigSchema.safeParse(options.config ?? {});
  if (!config.success) {
    throw new AppError("CONFIG_INVALID", { message: "Invalid protected web fetch configuration" });
  }
  const { max_redirects: maxRedirects, max_bytes: maxBytes } = config.data;
  const deniedDomains = ["localhost", "local", ...config.data.denied_domains.map(deniedDomain)];
  const types = new Set(config.data.content_types.map((type) => type.trim().toLowerCase()));
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    fetchText: (input) =>
      withDeadline(async (signal): Promise<WebDocument> => {
        let url = targetUrl(input, deniedDomains);
        const requestedUrl = url.href;
        for (let redirects = 0; ; redirects++) {
          signal.throwIfAborted();
          const addresses: readonly unknown[] = await options.resolve(url.hostname, signal);
          if (!Array.isArray(addresses)) {
            throw new AppError("SSRF_BLOCKED", { message: "Web DNS returned a malformed answer" });
          }
          if (addresses.length === 0) {
            throw new AppError("UPSTREAM_UNAVAILABLE", {
              message: "Web hostname has no DNS addresses",
            });
          }
          let address: string | undefined;
          for (const answer of addresses) {
            if (!isPublicAddress(answer)) {
              throw new AppError("SSRF_BLOCKED", {
                message: "Web DNS returned a non-public address",
              });
            }
            address ??= answer;
          }
          if (address === undefined) {
            throw new AppError("SSRF_BLOCKED", { message: "Web DNS returned a malformed answer" });
          }
          signal.throwIfAborted();

          const request = new Request(url, {
            credentials: "omit",
            headers: { "user-agent": USER_AGENT },
            redirect: "manual",
            signal,
          });
          const response = await options.fetchPinned({ request, address });
          checkManualResponse(request, response, "SSRF_BLOCKED");
          if (isRedirect(response)) {
            const location = redirectLocation(response);
            if (redirects === maxRedirects) {
              throw new AppError("SSRF_BLOCKED", { message: "Web redirect limit exceeded" });
            }
            url = targetUrl(location, deniedDomains, url);
            continue;
          }
          if (response.status !== 200) {
            rejectStatus(response);
          }
          const contentType = (response.headers.get("content-type")?.split(";", 1)[0] ?? "")
            .trim()
            .toLowerCase();
          if (contentType === "" || !types.has(contentType)) {
            discardBody(response);
            throw new AppError("CONTENT_UNSUPPORTED", {
              message: "Web response media type is not allowed",
            });
          }
          const body = await readText(response, maxBytes, signal);
          const text =
            contentType === "text/html" || contentType === "application/xhtml+xml"
              ? extractHtmlText(body.text)
              : body.text;
          return {
            requested_url: requestedUrl,
            final_url: url.href,
            content_type: contentType,
            text,
            truncated: body.truncated,
            content_hash: await contentHash(text),
          };
        }
      }, timeoutMs),
  };
}

import type { EpochMs } from "@ai-news-tracker/contracts/primitives";

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
}

export interface SignableRequest {
  readonly method: string;
  readonly url: URL;
  // Header names are compared case-insensitively; every header given here is signed.
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface SigningScope {
  readonly service: string;
  readonly region: string;
  readonly credentials: AwsCredentials;
  readonly at: EpochMs;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
}

// RFC 3986 unreserved characters stay; everything else is percent-encoded with uppercase hex,
// which is stricter than encodeURIComponent for !'()*.
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// S3 signs the path as sent; every other service signs each segment encoded once more.
function canonicalPath(url: URL, service: string): string {
  const path = url.pathname === "" ? "/" : url.pathname;
  if (service === "s3") return path;
  return path
    .split("/")
    .map((segment) => uriEncode(segment))
    .join("/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .toSorted(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue < rightValue
          ? -1
          : leftValue > rightValue
            ? 1
            : 0
        : leftKey < rightKey
          ? -1
          : 1,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function amzDate(at: EpochMs): string {
  return new Date(at)
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
}

// Returns the headers to send: the caller's headers plus host, date, payload hash, token and
// authorization.
export async function signRequest(
  request: SignableRequest,
  scope: SigningScope,
): Promise<Record<string, string>> {
  const timestamp = amzDate(scope.at);
  const date = timestamp.slice(0, 8);
  const payloadHash = await sha256Hex(request.body);
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(request.headers)) {
    headers.set(name.toLowerCase(), value);
  }
  headers.set("host", request.url.host);
  headers.set("x-amz-date", timestamp);
  headers.set("x-amz-content-sha256", payloadHash);
  if (scope.credentials.sessionToken !== undefined && scope.credentials.sessionToken !== "") {
    headers.set("x-amz-security-token", scope.credentials.sessionToken);
  }
  const names = [...headers.keys()].toSorted();
  const canonicalHeaders = names
    .map((name) => `${name}:${(headers.get(name) ?? "").trim().replace(/\s+/gu, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(request.url, scope.service),
    canonicalQuery(request.url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${date}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    timestamp,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const dateKey = await hmac(encoder.encode(`AWS4${scope.credentials.secretAccessKey}`), date);
  const regionKey = await hmac(dateKey, scope.region);
  const serviceKey = await hmac(regionKey, scope.service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  const signed: Record<string, string> = {};
  for (const name of names) {
    if (name !== "host") signed[name] = headers.get(name) ?? "";
  }
  signed["authorization"] =
    `${ALGORITHM} Credential=${scope.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return signed;
}

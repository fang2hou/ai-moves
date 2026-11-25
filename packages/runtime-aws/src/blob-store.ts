import { blobKey, type BlobRef, type BlobStore } from "@ai-moves/contracts/ports/storage";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import type { AwsEndpoint } from "./json-client.ts";
import { sha256Hex, signRequest } from "./sigv4.ts";

export interface S3BucketOptions extends AwsEndpoint {
  readonly bucket: string;
}

function objectUrl(options: S3BucketOptions, key: string): URL {
  const path = key.split("/").map(encodeURIComponent).join("/");
  // An endpoint override (a local emulator) is addressed path-style; AWS itself virtual-hosted.
  return options.endpoint === undefined
    ? new URL(`https://${options.bucket}.s3.${options.region}.amazonaws.com/${path}`)
    : new URL(`${options.endpoint.replace(/\/$/u, "")}/${options.bucket}/${path}`);
}

function unavailable(
  operation: string,
  detail: Record<string, unknown>,
  cause?: unknown,
): AppError {
  return new AppError("STORAGE_UNAVAILABLE", {
    message: `STORAGE_UNAVAILABLE: S3 ${operation} failed`,
    ...(cause === undefined ? {} : { cause }),
    context: { operation, ...detail },
  });
}

// Content addressed like the R2 store: the key is the SHA-256 of the bytes, and a put of bytes
// already stored is skipped. Reading a missing key needs s3:ListBucket, or S3 answers 403.
export function createS3BlobStore(options: S3BucketOptions): BlobStore {
  async function send(
    method: "GET" | "HEAD" | "PUT",
    key: string,
    body: Uint8Array = new Uint8Array(),
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const url = objectUrl(options, key);
    const signed = await signRequest(
      { method, url, headers, body },
      {
        service: "s3",
        region: options.region,
        credentials: await options.credentials(),
        at: options.clock.now(),
      },
    );
    try {
      return await options.fetch(
        new Request(url, {
          method,
          headers: signed,
          ...(method === "PUT" ? { body: Uint8Array.from(body) } : {}),
          signal: AbortSignal.timeout(options.timeoutMs),
        }),
      );
    } catch (cause) {
      throw unavailable(method, {}, cause);
    }
  }

  async function has(key: string): Promise<boolean> {
    const response = await send("HEAD", key);
    await response.body?.cancel();
    if (response.status === 404) return false;
    if (response.ok) return true;
    throw unavailable("HEAD", { status: response.status });
  }

  return {
    async put(body, putOptions): Promise<BlobRef> {
      const bytes =
        typeof body === "string" ? new TextEncoder().encode(body) : Uint8Array.from(body);
      const contentHash = await sha256Hex(bytes);
      const ref: BlobRef = {
        key: blobKey(contentHash),
        content_hash: contentHash,
        size: bytes.byteLength,
      };
      if (await has(ref.key)) return ref;
      const response = await send("PUT", ref.key, bytes, {
        "content-type": putOptions.contentType,
      });
      await response.body?.cancel();
      if (!response.ok) throw unavailable("PUT", { status: response.status });
      return ref;
    },
    async get(key) {
      const response = await send("GET", key);
      if (response.status === 404) return null;
      if (!response.ok) throw unavailable("GET", { status: response.status });
      try {
        return new Uint8Array(await response.arrayBuffer());
      } catch (cause) {
        throw unavailable("GET", {}, cause);
      }
    },
    has,
  };
}

import {
  blobKey,
  type BlobPutOptions,
  type BlobRef,
  type BlobStore,
} from "@ai-moves/contracts/ports/storage";
import { missingBinding, platformFailure } from "./failures.ts";

interface R2BlobObject {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2BlobBinding {
  get(key: string): Promise<R2BlobObject | null>;
  head(key: string): Promise<unknown>;
  put(
    key: string,
    value: Uint8Array<ArrayBuffer>,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function copyBody(body: Uint8Array | string): Uint8Array<ArrayBuffer> {
  return typeof body === "string" ? new TextEncoder().encode(body) : Uint8Array.from(body);
}

function reference(bytes: Uint8Array, contentHash: string): BlobRef {
  return { key: blobKey(contentHash), content_hash: contentHash, size: bytes.byteLength };
}

async function putOnce(
  bucket: R2BlobBinding,
  bytes: Uint8Array<ArrayBuffer>,
  options: BlobPutOptions,
  ref: BlobRef,
): Promise<BlobRef> {
  if ((await bucket.head(ref.key)) === null) {
    await bucket.put(ref.key, bytes, { httpMetadata: { contentType: options.contentType } });
  }
  return ref;
}

export function createCloudflareBlobStore(bucket: R2BlobBinding | undefined): BlobStore {
  if (bucket === undefined) {
    throw missingBinding("CONFIG_INVALID", "R2 bucket");
  }
  return {
    put: async (body, options) => {
      const bytes = copyBody(body);
      try {
        const contentHash = await sha256Hex(bytes);
        return await putOnce(bucket, bytes, options, reference(bytes, contentHash));
      } catch (error) {
        throw platformFailure("STORAGE_UNAVAILABLE", "R2 put", error);
      }
    },
    get: async (key) => {
      try {
        const object = await bucket.get(key);
        return object === null ? null : new Uint8Array(await object.arrayBuffer());
      } catch (error) {
        throw platformFailure("STORAGE_UNAVAILABLE", "R2 get", error);
      }
    },
    has: async (key) => {
      try {
        return (await bucket.head(key)) !== null;
      } catch (error) {
        throw platformFailure("STORAGE_UNAVAILABLE", "R2 head", error);
      }
    },
  };
}

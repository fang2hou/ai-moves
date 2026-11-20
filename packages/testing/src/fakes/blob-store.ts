import { blobKey, type BlobRef, type BlobStore } from "@ai-moves/contracts/ports/storage";

export interface InMemoryBlobStore extends BlobStore {
  readonly size: number;
  contentType(key: string): string | undefined;
}

interface StoredBlob {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createInMemoryBlobStore(): InMemoryBlobStore {
  const blobs = new Map<string, StoredBlob>();
  return {
    get size() {
      return blobs.size;
    },
    contentType: (key) => blobs.get(key)?.contentType,
    put: async (body, options): Promise<BlobRef> => {
      const bytes =
        typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
      const contentHash = await sha256Hex(bytes);
      const key = blobKey(contentHash);
      if (!blobs.has(key)) {
        blobs.set(key, { bytes, contentType: options.contentType });
      }
      return { key, content_hash: contentHash, size: bytes.byteLength };
    },
    get: (key) => {
      const blob = blobs.get(key);
      return Promise.resolve(blob === undefined ? null : new Uint8Array(blob.bytes));
    },
    has: (key) => Promise.resolve(blobs.has(key)),
  };
}

import { blobKey, type BlobStore } from "@ai-moves/contracts/ports/storage";
import { expect } from "vitest";

import { definePortContract } from "./define.ts";

export interface BlobStoreHarness {
  readonly store: BlobStore;
}

// FIPS 180-4 test vectors.
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const text = { contentType: "text/plain" };
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array | null): string | null =>
  value === null ? null : new TextDecoder().decode(value);

export const blobStoreContract = definePortContract<BlobStoreHarness>("BlobStore", [
  {
    name: "addresses content by the SHA-256 of its bytes",
    run: async ({ store }) => {
      expect(await store.put("abc", text)).toEqual({
        key: blobKey(SHA256_ABC),
        content_hash: SHA256_ABC,
        size: 3,
      });
      expect(await store.put("", text)).toEqual({
        key: blobKey(SHA256_EMPTY),
        content_hash: SHA256_EMPTY,
        size: 0,
      });
    },
  },
  {
    name: "returns the bytes that were stored",
    run: async ({ store }) => {
      const ref = await store.put("release notes with unicode: 変更履歴", text);
      expect(decode(await store.get(ref.key))).toBe("release notes with unicode: 変更履歴");
      expect(ref.size).toBe(encode("release notes with unicode: 変更履歴").byteLength);
      expect(await store.has(ref.key)).toBe(true);
    },
  },
  {
    name: "is idempotent: the same content yields the same reference, as text or as bytes",
    run: async ({ store }) => {
      const first = await store.put("same", text);
      const second = await store.put("same", { contentType: "text/html" });
      const third = await store.put(encode("same"), text);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    },
  },
  {
    name: "gives different content different keys",
    run: async ({ store }) => {
      const left = await store.put("left", text);
      const right = await store.put("right", text);
      expect(left.key).not.toBe(right.key);
      expect(decode(await store.get(left.key))).toBe("left");
      expect(decode(await store.get(right.key))).toBe("right");
    },
  },
  {
    name: "reports an unknown key as absent",
    run: async ({ store }) => {
      expect(await store.get(blobKey(SHA256_ABC))).toBeNull();
      expect(await store.has(blobKey(SHA256_ABC))).toBe(false);
    },
  },
  {
    name: "does not let a caller mutate stored content",
    run: async ({ store }) => {
      const input = encode("immutable");
      const ref = await store.put(input, text);
      input.fill(0);
      const read = await store.get(ref.key);
      read?.fill(0);
      expect(decode(await store.get(ref.key))).toBe("immutable");
    },
  },
]);

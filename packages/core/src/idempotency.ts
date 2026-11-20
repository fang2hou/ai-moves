import type { ContentHash, EntityId, Lang } from "@ai-moves/contracts/primitives";
import type { AlertKind, AnalysisStage } from "@ai-moves/contracts/states";

const DIGEST_LENGTH = 32;
const BLOCK_WORDS = 64;

const rightRotate = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

const constants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function frame(parts: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const frames = parts.map((part) => {
    const bytes = encoder.encode(part);
    const length = encoder.encode(`${bytes.byteLength}:`);
    const framed = new Uint8Array(length.byteLength + bytes.byteLength);
    framed.set(length);
    framed.set(bytes, length.byteLength);
    return framed;
  });
  const length = frames.reduce((total, framed) => total + framed.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const framed of frames) {
    output.set(framed, offset);
    offset += framed.byteLength;
  }
  return output;
}

function sha256(input: Uint8Array<ArrayBuffer>): ContentHash {
  const bitLength = input.byteLength * 8;
  const paddedLength = Math.ceil((input.byteLength + 9) / BLOCK_WORDS) * BLOCK_WORDS;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(BLOCK_WORDS);
  for (let block = 0; block < paddedLength; block += BLOCK_WORDS) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(block + index * 4);
    for (let index = 16; index < BLOCK_WORDS; index += 1) {
      const first = words[index - 15] ?? 0;
      const second = words[index - 2] ?? 0;
      const s0 = rightRotate(first, 7) ^ rightRotate(first, 18) ^ (first >>> 3);
      const s1 = rightRotate(second, 17) ^ rightRotate(second, 19) ^ (second >>> 10);
      words[index] = ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0;
    }

    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;
    for (let index = 0; index < BLOCK_WORDS; index += 1) {
      const sum1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + (constants[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }

  return [...state]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("")
    .slice(0, DIGEST_LENGTH * 2);
}

export function stableKey(...parts: readonly string[]): ContentHash {
  return sha256(frame(parts));
}

export interface AnalysisKeyInput {
  readonly itemId: EntityId;
  readonly stage: AnalysisStage;
  readonly inputHash: ContentHash;
  readonly promptVersion: string;
  readonly lang: Lang;
}

export const pollScheduleKey = (sourceId: EntityId, tickBucket: number): ContentHash =>
  stableKey("poll-schedule", sourceId, String(tickBucket));
export const itemKey = (externalKey: string): ContentHash => stableKey("item", externalKey);
export const revisionKey = (itemId: EntityId, contentHash: ContentHash): ContentHash =>
  stableKey("revision", itemId, contentHash);
export const analysisKey = (input: AnalysisKeyInput): ContentHash =>
  stableKey(
    "analysis",
    input.itemId,
    input.stage,
    input.inputHash,
    input.promptVersion,
    input.lang,
  );
export const alertKey = (clusterId: string, kind: AlertKind): ContentHash =>
  stableKey("alert", clusterId, kind);
export const deliveryKey = (alertId: EntityId, destinationId: EntityId): ContentHash =>
  stableKey("delivery", alertId, destinationId);

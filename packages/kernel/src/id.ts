import type { Clock, IdGen } from "@ai-moves/contracts/ports/runtime";

export type RandomBytes = (length: number) => Uint8Array;

export interface IdGenOptions {
  readonly clock: Clock;
  readonly randomBytes?: RandomBytes;
}

const UUID_BYTES = 16;
const TIMESTAMP_BYTES = 6;

const secureRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

function hex(bytes: Uint8Array, start: number, end: number): string {
  return Array.from(bytes.subarray(start, end), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

// UUID version 7 (RFC 9562): a 48-bit millisecond timestamp followed by random bits, so ids sort
// by creation time. Ids created within the same millisecond are not ordered among themselves.
export function createIdGen(options: IdGenOptions): IdGen {
  const randomBytes = options.randomBytes ?? secureRandomBytes;
  return {
    next: () => {
      const bytes = new Uint8Array(UUID_BYTES);
      bytes.set(randomBytes(UUID_BYTES).subarray(0, UUID_BYTES));
      let timestamp = options.clock.now();
      for (let index = TIMESTAMP_BYTES - 1; index >= 0; index -= 1) {
        bytes[index] = timestamp % 256;
        timestamp = Math.floor(timestamp / 256);
      }
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
      return [
        hex(bytes, 0, 4),
        hex(bytes, 4, 6),
        hex(bytes, 6, 8),
        hex(bytes, 8, 10),
        hex(bytes, 10, 16),
      ].join("-");
    },
  };
}

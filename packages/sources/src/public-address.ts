function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part))) {
    return null;
  }
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}

export function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || ipv4Parts(hostname) !== null;
}

export function isPublicAddress(address: unknown): address is string {
  if (typeof address !== "string") {
    return false;
  }
  const bytes = ipv4Parts(address);
  if (bytes !== null) {
    const [a = 0, b = 0, c = 0] = bytes;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }

  if (!address.includes(":") || !/^[\da-f:.]+$/i.test(address)) {
    return false;
  }
  const canonical = URL.parse(`https://[${address}]/`);
  if (canonical === null) {
    return false;
  }
  const [first, second] = canonical.hostname.slice(1, -1).split(":");
  const a = Number.parseInt(first ?? "", 16);
  const b = Number.parseInt(second || "0", 16);
  // Only global unicast; exclude protocol assignments, transition, and documentation prefixes.
  return (
    a >= 0x2000 &&
    a < 0x4000 &&
    !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) &&
    a !== 0x2002 &&
    !(a === 0x3fff && b < 0x1000)
  );
}

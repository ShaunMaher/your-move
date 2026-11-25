/**
 * Client IPs and their rate-limit buckets (docs/spec/08-security.md §4.1). Pure functions over
 * strings, so both runtimes share them: Workers read `CF-Connecting-IP`; Node passes its socket
 * address and `TRUST_PROXY` settings to {@link resolveClientIp}.
 */

/** A parsed address: 4 bytes for IPv4, 16 for IPv6. IPv4-mapped IPv6 is already IPv4. */
export interface ParsedIp {
  readonly version: 4 | 6;
  readonly bytes: Uint8Array;
}

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (const [i, part] of parts.entries()) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6(text: string): Uint8Array | null {
  if (!/^[0-9a-f:.]+$/iu.test(text) || text.length > 45) return null;
  let head = text;
  let tail4: Uint8Array | null = null;
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    tail4 = parseIpv4(text.slice(lastColon + 1));
    if (tail4 === null) return null;
    head = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const group = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const left = group(halves[0] ?? "");
  const right = halves.length === 2 ? group(halves[1] ?? "") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  const bytes = new Uint8Array(16);
  for (const [i, value] of groups.entries()) {
    if (!/^[0-9a-f]{1,4}$/iu.test(value)) return null;
    const number = Number.parseInt(value, 16);
    bytes[i * 2] = number >> 8;
    bytes[i * 2 + 1] = number & 0xff;
  }
  if (tail4 !== null) bytes.set(tail4, 12);
  return bytes;
}

const MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

/**
 * Parses an IPv4 or IPv6 address (no zone, no brackets, no port). IPv4-mapped IPv6
 * (`::ffff:a.b.c.d`) is normalised to IPv4 before anything else sees it (08 §4.1).
 */
export function parseIp(text: string): ParsedIp | null {
  const value = text.trim();
  const v4 = parseIpv4(value);
  if (v4 !== null) return { version: 4, bytes: v4 };
  const v6 = parseIpv6(value);
  if (v6 === null) return null;
  if (MAPPED_PREFIX.every((byte, i) => v6[i] === byte)) {
    return { version: 4, bytes: v6.slice(12) };
  }
  return { version: 6, bytes: v6 };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One rate-limit bucket of a client address and its limit multiplier (08 §4.1). */
export interface IpBucket {
  /** e.g. `4/c0a80001`, `6/64/20010db8…`: never hashed here; callers HMAC it under `ip/v1`. */
  readonly bucket: string;
  readonly multiplier: number;
}

/**
 * The buckets an address counts in: IPv4 → its /32; IPv6 → its /64 at the listed limit, /56 at 4×
 * and /48 at 10×, all checked (08 §4.1).
 */
export function ipBuckets(ip: ParsedIp): IpBucket[] {
  if (ip.version === 4) return [{ bucket: `4/${hex(ip.bytes)}`, multiplier: 1 }];
  return [
    { bucket: `6/64/${hex(ip.bytes.slice(0, 8))}`, multiplier: 1 },
    { bucket: `6/56/${hex(ip.bytes.slice(0, 7))}`, multiplier: 4 },
    { bucket: `6/48/${hex(ip.bytes.slice(0, 6))}`, multiplier: 10 },
  ];
}

/** Whether `ip` is inside a CIDR block such as `10.0.0.0/8` or `fc00::/7`. */
export function inCidr(ip: ParsedIp, cidr: string): boolean {
  const [base, prefixText] = cidr.split("/");
  const network = parseIp(base ?? "");
  const prefix = Number(prefixText);
  if (network?.version !== ip.version || !Number.isInteger(prefix)) return false;
  for (let bit = 0; bit < prefix; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if (((ip.bytes[byte] ?? 0) & mask) !== ((network.bytes[byte] ?? 0) & mask)) return false;
  }
  return true;
}

/** Where the client address comes from (09 §1 `TRUST_PROXY`; Workers always `cloudflare`). */
export type TrustProxy = "false" | "xff" | "cloudflare";

export interface ClientIpSource {
  readonly mode: TrustProxy;
  /** The socket peer's address; `null` on Workers, where there is none to check. */
  readonly socketAddress: string | null;
  /** `TRUST_PROXY_HOPS` (xff only). */
  readonly hops: number;
  /** `TRUST_PROXY_PEERS`: the socket peer must be in one (xff and cloudflare on Node). */
  readonly trustedPeers: readonly string[];
}

export type ClientIp =
  | { readonly ok: true; readonly ip: ParsedIp }
  | { readonly ok: false; readonly reason: "missing" | "untrusted-peer" };

/**
 * Resolves the client address of one request (08 §4.1): the socket address; or, behind trusted
 * proxies, the `X-Forwarded-For` entry `hops` positions from the right (the left entries are
 * attacker-controlled) or `CF-Connecting-IP`. Behind a proxy the socket peer must be a trusted
 * one. A missing or invalid address, or too few `X-Forwarded-For` entries, is `missing`; routes
 * that use the address answer it with `400`.
 */
export function resolveClientIp(headers: Headers, source: ClientIpSource): ClientIp {
  const missing = { ok: false, reason: "missing" } as const;
  const parse = (text: string | null | undefined): ClientIp => {
    const ip = text === null || text === undefined ? null : parseIp(text);
    return ip === null ? missing : { ok: true, ip };
  };
  if (source.mode === "false") return parse(source.socketAddress);
  if (source.socketAddress !== null) {
    const peer = parseIp(source.socketAddress);
    if (peer === null || !source.trustedPeers.some((cidr) => inCidr(peer, cidr))) {
      return { ok: false, reason: "untrusted-peer" };
    }
  }
  if (source.mode === "cloudflare") return parse(headers.get("CF-Connecting-IP"));
  const entries = (headers.get("X-Forwarded-For") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return parse(entries[entries.length - source.hops]);
}

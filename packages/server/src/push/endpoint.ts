/**
 * What a push subscription may hold (docs/spec/08-security.md T12, 04 `push_subscriptions`): an
 * endpoint at one of the allow-listed push services, so the server never posts to an address a
 * client picked (SSRF), and keys that are a real P-256 point and a 16-byte auth secret.
 */
import { fromBase64Url } from "../base64.js";

/** The push services browsers use (T12). A host must be one of these or end in `.` + one. */
const PUSH_SERVICES = [
  "push.apple.com",
  "fcm.googleapis.com",
  "notify.windows.com",
  "push.services.mozilla.com",
] as const;

/** Subscriptions kept per user, the least recently useful evicted (04, 08 T12). */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

/** The longest endpoint accepted; real ones are a few hundred characters. */
const MAX_ENDPOINT_LENGTH = 2048;

/** A dotted IPv4 address as the URL parser writes every IPv4 host (hex and octal forms included). */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * The endpoint as a parsed URL, or null when T12 refuses it: `https:` only, no userinfo, no port
 * other than 443, no IP literal, no fragment, and a host equal to an allow-listed push service or
 * a subdomain of one at a label boundary (`x.push.apple.com` but never `evilpush.apple.com` or
 * `push.apple.com.evil.tld`). The URL parser lower-cases the host and turns non-ASCII labels into
 * punycode first, so look-alike characters can't match; a trailing dot is refused, not stripped.
 * The caller stores and posts to the parsed URL's `href`, never the raw string.
 */
export function parseEndpoint(raw: string): URL | null {
  if (raw.length > MAX_ENDPOINT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  // The parser drops the default port, so an explicit `:443` reads as "".
  if (url.port !== "") return null;
  if (url.hash !== "" || raw.includes("#")) return null;
  const host = url.hostname;
  if (host.startsWith("[") || IPV4.test(host)) return null;
  const allowed = PUSH_SERVICES.some((service) => host === service || host.endsWith(`.${service}`));
  return allowed ? url : null;
}

/** Strict unpadded base64url: what `PushSubscription.toJSON()` gives. */
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function decode(value: string): Uint8Array | null {
  if (!BASE64URL.test(value)) return null;
  try {
    return fromBase64Url(value);
  } catch {
    return null;
  }
}

/**
 * The subscription's keys, decoded, or null when T12 refuses them: `p256dh` an uncompressed P-256
 * point (65 bytes, `0x04` first) that WebCrypto accepts as a point on the curve, `auth` 16 bytes.
 */
export async function parseKeys(keys: {
  readonly p256dh: string;
  readonly auth: string;
}): Promise<{ p256dh: Uint8Array<ArrayBuffer>; auth: Uint8Array<ArrayBuffer> } | null> {
  const p256dh = decode(keys.p256dh);
  const auth = decode(keys.auth);
  if (p256dh?.length !== 65 || p256dh[0] !== 0x04 || auth?.length !== 16) return null;
  const point = new Uint8Array(p256dh);
  try {
    await crypto.subtle.importKey("raw", point, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    return null;
  }
  return { p256dh: point, auth: new Uint8Array(auth) };
}

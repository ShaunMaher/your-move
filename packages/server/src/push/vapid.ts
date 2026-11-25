/**
 * VAPID (RFC 8292): the application server identifies itself to a push service with a short-lived
 * ES256 JWT signed by the instance's VAPID private key, sent with the public key in the
 * `Authorization` header. WebCrypto only (docs/spec/03-architecture.md §7).
 *
 * Keys are configured as unpadded base64url (09 §1, `pnpm gen:vapid`): the public key as the
 * 65-byte uncompressed P-256 point (what browsers take as `applicationServerKey`), the private key
 * as the 32-byte scalar.
 */
import { fromBase64Url, toBase64Url } from "../base64.js";

/** How long a token is good for; RFC 8292 §2 allows at most 24 hours. */
const TOKEN_LIFETIME_S = 12 * 60 * 60;

const encoder = new TextEncoder();

/** The VAPID configuration (09 §1). */
export interface VapidConfig {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

/** A VAPID key pair, ready to sign with. */
export interface VapidKeys {
  readonly signingKey: CryptoKey;
  /** `k=` of the header: the configured public key. */
  readonly publicKey: string;
  readonly subject: string;
}

const MISMATCH = "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: not a matching P-256 key pair";

/** Thrown when the configured keys aren't a matching P-256 pair; names no value. */
export class VapidKeyError extends Error {
  override readonly name = "VapidKeyError";
}

/** Whether the strings have the shapes of a VAPID public and private key (checked at startup). */
export function vapidKeyShapes(publicKey: string, privateKey: string): boolean {
  const base64url = /^[A-Za-z0-9_-]+$/u;
  if (!base64url.test(publicKey) || !base64url.test(privateKey)) return false;
  try {
    const point = fromBase64Url(publicKey);
    return point.length === 65 && point[0] === 0x04 && fromBase64Url(privateKey).length === 32;
  } catch {
    return false;
  }
}

/**
 * Imports the configured pair for signing, and checks that the private key belongs to the public
 * key by signing and verifying once, so a mismatch is reported here rather than as every push
 * service's `403`.
 */
export async function importVapidKeys(config: VapidConfig): Promise<VapidKeys> {
  if (!vapidKeyShapes(config.publicKey, config.privateKey)) {
    throw new VapidKeyError("VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY is not a P-256 key");
  }
  const point = fromBase64Url(config.publicKey);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(point.slice(1, 33)),
    y: toBase64Url(point.slice(33, 65)),
  };
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  let signingKey: CryptoKey;
  let verifyingKey: CryptoKey;
  try {
    signingKey = await crypto.subtle.importKey(
      "jwk",
      { ...jwk, d: config.privateKey },
      algorithm,
      false,
      ["sign"],
    );
    verifyingKey = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
  } catch {
    // WebCrypto may itself refuse a private key that doesn't match the public point.
    throw new VapidKeyError(MISMATCH);
  }
  const probe = encoder.encode("vapid key check");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, probe);
  const matches = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyingKey,
    signature,
    probe,
  );
  if (!matches) throw new VapidKeyError(MISMATCH);
  return { signingKey, publicKey: config.publicKey, subject: config.subject };
}

function base64UrlJson(value: unknown): string {
  return toBase64Url(encoder.encode(JSON.stringify(value)));
}

/**
 * The `Authorization` header for a push to `endpoint` (RFC 8292 §3): `vapid t=<JWT>, k=<key>`. The
 * JWT's audience is the push service's origin, it expires 12 hours from `nowMs`, and its subject is
 * `VAPID_SUBJECT`. WebCrypto's ECDSA signature is already JWS's `r || s` form (RFC 7518 §3.4).
 */
export async function vapidAuthorization(
  endpoint: URL,
  keys: VapidKeys,
  nowMs: number,
): Promise<string> {
  const header = base64UrlJson({ typ: "JWT", alg: "ES256" });
  const claims = base64UrlJson({
    aud: endpoint.origin,
    exp: Math.floor(nowMs / 1000) + TOKEN_LIFETIME_S,
    sub: keys.subject,
  });
  const signingInput = `${header}.${claims}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.signingKey,
      encoder.encode(signingInput),
    ),
  );
  return `vapid t=${signingInput}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

/**
 * HKDF subkeys of `APP_SECRET` (docs/spec/09-operations.md §1.1, 08): one HMAC-SHA256 key per
 * purpose, each derived with HKDF-SHA256 and its own versioned `info` label, so a leak or rotation
 * of one never touches the others. WebCrypto only (03 §1); the keys are non-extractable.
 *
 * Changing a label or the derivation changes every value hashed with it (09 §1.1 lists what
 * breaks), so both are fixed by known-answer tests.
 */

/** Every subkey label (09 §1.1). Bump the version to rotate one, never edit it. */
export const SUBKEY_LABELS = {
  /** OTP code hashing (06 §3). */
  otp: "otp/v1",
  /** IP-bucket hashing in rate limits and audit events (08 §4.1). */
  ip: "ip/v1",
  /** Unsubscribe token MAC (05 §Email links). */
  unsub: "unsub/v1",
  /** `emailId`: suppression list, per-target invite limits, log identifiers. */
  emailId: "email-id/v1",
  /** API token hashing (06 §8). */
  token: "token/v1",
} as const;

export type SubkeyName = keyof typeof SUBKEY_LABELS;

/** One non-extractable HMAC-SHA256 key per label. */
export type Subkeys = Readonly<Record<SubkeyName, CryptoKey>>;

/**
 * HKDF salt. RFC 5869 §3.1: with a uniformly random input key (`APP_SECRET` is ≥ 32 random bytes)
 * an unsalted extract is sound; an empty salt is a string of zero bytes. Fixed forever, like the
 * labels.
 */
const SALT = new Uint8Array(0);

const encoder = new TextEncoder();

/** Derives one subkey's raw 32 bytes. Exposed for the known-answer tests. */
export async function deriveSubkeyBytes(
  appSecret: Uint8Array,
  label: string,
): Promise<Uint8Array<ArrayBuffer>> {
  // A copy backed by a plain ArrayBuffer, as WebCrypto requires.
  const root = await crypto.subtle.importKey("raw", new Uint8Array(appSecret), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode(label) },
    root,
    256,
  );
  return new Uint8Array(bits);
}

/** Derives every subkey from the decoded `APP_SECRET`. */
export async function deriveSubkeys(appSecret: Uint8Array): Promise<Subkeys> {
  const entries = await Promise.all(
    Object.entries(SUBKEY_LABELS).map(async ([name, label]) => {
      const bytes = await deriveSubkeyBytes(appSecret, label);
      const key = await crypto.subtle.importKey(
        "raw",
        bytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
      return [name, key] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<SubkeyName, CryptoKey>;
}

/** HMAC-SHA256 of `message` under `key`, as lower-case hex. */
export async function hmacHex(
  key: CryptoKey,
  message: string | Uint8Array<ArrayBuffer>,
): Promise<string> {
  const data = typeof message === "string" ? encoder.encode(message) : message;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Verifies an HMAC-SHA256 hex digest in constant time (WebCrypto's `verify` compares without
 * early exit). A malformed digest is simply false.
 */
export async function verifyHmacHex(
  key: CryptoKey,
  message: string | Uint8Array<ArrayBuffer>,
  digest: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/u.test(digest)) return false;
  const data = typeof message === "string" ? encoder.encode(message) : message;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.verify("HMAC", key, bytes, data);
}

/** `emailId` (09 §1.1): the HMAC of an already normalised address under `email-id/v1`. */
export function emailId(keys: Subkeys, normalisedEmail: string): Promise<string> {
  return hmacHex(keys.emailId, normalisedEmail);
}

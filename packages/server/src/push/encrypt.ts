/**
 * Web Push message encryption (RFC 8291, with RFC 8188's `aes128gcm` content coding), WebCrypto
 * only so it runs on Workers and Node alike (docs/spec/03-architecture.md §7). Each message gets a
 * fresh ephemeral ECDH key pair and a fresh salt; tests pass fixed ones to check the RFC's example.
 */

const encoder = new TextEncoder();
/** One record of this size holds every message we send (RFC 8188 §2). */
const RECORD_SIZE = 4096;
/** Salt (16), record size (4), key id length (1) and the 65-byte key id. */
const HEADER_LENGTH = 16 + 4 + 1 + 65;
/** AES-GCM's tag. */
const TAG_LENGTH = 16;
/**
 * The largest plaintext a push service accepts: they take bodies of up to 4096 bytes (RFC 8030
 * §7.2), and the header, the padding delimiter and the tag come out of that.
 */
export const MAX_PLAINTEXT_BYTES = 4096 - HEADER_LENGTH - 1 - TAG_LENGTH;

/** The user agent's half of a subscription, decoded (`keys.p256dh` and `keys.auth`). */
export interface ClientKeys {
  readonly p256dh: Uint8Array<ArrayBuffer>;
  readonly auth: Uint8Array<ArrayBuffer>;
}

/** The sender's ephemeral half: fixed only in tests. */
export interface EphemeralKeys {
  readonly privateKey: CryptoKey;
  /** The uncompressed public point (65 bytes). */
  readonly publicKey: Uint8Array<ArrayBuffer>;
  readonly salt: Uint8Array<ArrayBuffer>;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** A fresh ephemeral key pair and salt (the production path). */
export async function freshEphemeralKeys(): Promise<EphemeralKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKey,
    salt: crypto.getRandomValues(new Uint8Array(16)),
  };
}

/**
 * The `aes128gcm` body of one push message (RFC 8291 §3.4, RFC 8188 §2): the header (salt, record
 * size, the sender's public key as key id) and a single record of the plaintext, its delimiter
 * `0x02` and no further padding. Throws for a plaintext over {@link MAX_PLAINTEXT_BYTES}.
 */
export async function encryptPushMessage(
  plaintext: Uint8Array,
  client: ClientKeys,
  ephemeral: EphemeralKeys,
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new RangeError("push message too long");
  const clientKey = await crypto.subtle.importKey(
    "raw",
    client.p256dh,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, ephemeral.privateKey, 256),
  );
  // RFC 8291 §3.3: the input keying material, bound to both public keys.
  const keyInfo = concat(encoder.encode("WebPush: info\0"), client.p256dh, ephemeral.publicKey);
  const ikm = await hkdf(client.auth, shared, keyInfo, 32);
  // RFC 8188 §2.2 and §2.3: the content encryption key and nonce.
  const cek = await hkdf(ephemeral.salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ephemeral.salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concat(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record),
  );
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(ephemeral.salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = ephemeral.publicKey.length;
  header.set(ephemeral.publicKey, 21);
  return concat(header, ciphertext);
}

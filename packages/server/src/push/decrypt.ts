/**
 * The user agent's side of RFC 8291, for tests only (exported through `@your-move/server/testing`):
 * decrypts a push body the way a browser would, so tests can read exactly what a push service
 * would carry to the device and nothing else.
 */

const encoder = new TextEncoder();

/** A browser's subscription keys: its ECDH key pair and auth secret. */
export interface TestClientKeys {
  readonly privateKey: CryptoKey;
  /** The uncompressed public point (65 bytes): `keys.p256dh`. */
  readonly publicKey: Uint8Array<ArrayBuffer>;
  /** `keys.auth` (16 bytes). */
  readonly auth: Uint8Array<ArrayBuffer>;
}

/** A fresh browser-side key pair and auth secret. */
export async function testClientKeys(): Promise<TestClientKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    auth: crypto.getRandomValues(new Uint8Array(16)),
  };
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  );
}

/** Decrypts a single-record `aes128gcm` push body (RFC 8291 §3.4) for the given client keys. */
export async function decryptPushMessage(
  body: Uint8Array,
  client: TestClientKeys,
): Promise<Uint8Array<ArrayBuffer>> {
  const salt = new Uint8Array(body.slice(0, 16));
  const idLength = body[20] ?? 0;
  const senderPublic = new Uint8Array(body.slice(21, 21 + idLength));
  const ciphertext = new Uint8Array(body.slice(21 + idLength));
  const senderKey = await crypto.subtle.importKey(
    "raw",
    senderPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, client.privateKey, 256),
  );
  const keyInfo = new Uint8Array([
    ...encoder.encode("WebPush: info\0"),
    ...client.publicKey,
    ...senderPublic,
  ]);
  const ikm = await hkdf(client.auth, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext),
  );
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (record[end] !== 0x02) throw new Error("not a last record");
  return record.slice(0, end);
}

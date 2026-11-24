/** SHA-256 with WebCrypto, the only hashing the runtime and the build use. */

/** The SHA-256 of some bytes, as lower-case hex. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The SHA-256 of a text's UTF-8 bytes, as lower-case hex. */
export function sha256TextHex(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

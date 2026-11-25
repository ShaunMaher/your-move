/**
 * Unsubscribe tokens (docs/spec/05-api.md §Email links, 08 T17): `base64url(payload ‖ MAC)`, where
 * the payload is the UTF-8 JSON `{"v":1,"purpose":…,"emailId":…}` and the MAC its HMAC-SHA256
 * under the `unsub/v1` subkey (09 §1.1), raw 32 bytes. The purpose is inside the MAC, so a token
 * is bound to it. Tokens don't expire and never contain the address.
 */
import { z } from "zod";

import { fromBase64Url, toBase64Url } from "../base64.js";
import type { Subkeys } from "../crypto/subkeys.js";

export type UnsubscribePurpose = "invites" | "nudges";

export interface UnsubscribeClaim {
  readonly purpose: UnsubscribePurpose;
  readonly emailId: string;
}

const MAC_BYTES = 32;
/** Far above a real token (about 180 characters), so nothing longer is decoded at all. */
const MAX_TOKEN_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

const PayloadSchema = z
  .object({
    v: z.literal(1),
    purpose: z.enum(["invites", "nudges"]),
    emailId: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const encoder = new TextEncoder();

/** A token for one address (by its `emailId`) and one purpose. */
export async function unsubscribeToken(keys: Subkeys, claim: UnsubscribeClaim): Promise<string> {
  const payload = encoder.encode(
    JSON.stringify({ v: 1, purpose: claim.purpose, emailId: claim.emailId }),
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", keys.unsub, payload));
  const token = new Uint8Array(payload.length + MAC_BYTES);
  token.set(payload);
  token.set(mac, payload.length);
  return toBase64Url(token);
}

/**
 * The claim of a valid token, or null for anything else: malformed, too long, a MAC that doesn't
 * verify (compared in constant time by WebCrypto), or a payload of any other shape.
 */
export async function verifyUnsubscribeToken(
  keys: Subkeys,
  token: string | undefined,
): Promise<UnsubscribeClaim | null> {
  if (token === undefined || token.length > MAX_TOKEN_LENGTH || !BASE64URL.test(token)) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(token);
  } catch {
    return null;
  }
  if (bytes.length <= MAC_BYTES) return null;
  const payload = bytes.slice(0, bytes.length - MAC_BYTES);
  const mac = bytes.slice(bytes.length - MAC_BYTES);
  if (!(await crypto.subtle.verify("HMAC", keys.unsub, mac, payload))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    return null;
  }
  const result = PayloadSchema.safeParse(parsed);
  return result.success ? { purpose: result.data.purpose, emailId: result.data.emailId } : null;
}

/** The unsubscribe link for a token: `PUBLIC_URL/api/v1/email/unsubscribe?t=<token>`. */
export function unsubscribeUrl(publicUrl: string, token: string): string {
  const url = new URL(UNSUBSCRIBE_PATH, publicUrl);
  url.searchParams.set("t", token);
  return url.toString();
}

/** The unsubscribe route (05 §Email links), exempt from the Origin and JSON rules. */
export const UNSUBSCRIBE_PATH = "/api/v1/email/unsubscribe";

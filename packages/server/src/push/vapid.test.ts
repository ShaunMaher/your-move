/** VAPID tokens (RFC 8292): the JWT's shape and claims, its signature, and key checks. */
import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url } from "../base64.js";
import { TEST_VAPID } from "../test-support.js";
import { importVapidKeys, VapidKeyError, vapidAuthorization, vapidKeyShapes } from "./vapid.js";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const SUBJECT = "mailto:ops@example.org";
const decode = (part: string): unknown => JSON.parse(new TextDecoder().decode(fromBase64Url(part)));

describe("vapidAuthorization (RFC 8292)", () => {
  it("signs an ES256 JWT for the push service's origin, valid for 12 hours", async () => {
    const keys = await importVapidKeys({ ...TEST_VAPID, subject: SUBJECT });
    const header = await vapidAuthorization(
      new URL("https://fcm.googleapis.com/fcm/send/abc?x=1"),
      keys,
      NOW,
    );
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/u.exec(header);
    expect(match).not.toBeNull();
    const [, head = "", claims = "", signature = "", k = ""] = match ?? [];
    expect(k).toBe(TEST_VAPID.publicKey);
    expect(decode(head)).toEqual({ typ: "JWT", alg: "ES256" });
    expect(decode(claims)).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: NOW / 1000 + 12 * 60 * 60,
      sub: SUBJECT,
    });
    // The signature is JWS's raw r || s and verifies with the public key the header names.
    const point = fromBase64Url(k);
    expect(fromBase64Url(signature)).toHaveLength(64);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: toBase64Url(point.slice(1, 33)),
        y: toBase64Url(point.slice(33)),
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      new Uint8Array(fromBase64Url(signature)),
      new TextEncoder().encode(`${head}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it("refuses a private key that doesn't belong to the public key", async () => {
    const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", other.privateKey);
    await expect(
      importVapidKeys({ ...TEST_VAPID, privateKey: jwk.d ?? "", subject: SUBJECT }),
    ).rejects.toThrow(VapidKeyError);
  });

  it.each([
    ["the documented pair", TEST_VAPID.publicKey, TEST_VAPID.privateKey, true],
    ["swapped", TEST_VAPID.privateKey, TEST_VAPID.publicKey, false],
    ["padded", `${TEST_VAPID.publicKey}=`, TEST_VAPID.privateKey, false],
    ["standard base64", TEST_VAPID.publicKey.replaceAll("_", "/"), TEST_VAPID.privateKey, false],
    ["a compressed point", toBase64Url(new Uint8Array(33).fill(2)), TEST_VAPID.privateKey, false],
    ["empty", "", "", false],
  ])("checks the key shapes: %s", (_name, publicKey, privateKey, ok) => {
    expect(vapidKeyShapes(publicKey, privateKey)).toBe(ok);
  });
});

import { describe, expect, it } from "vitest";

import type { NormalisedEmail } from "../accounts/email.js";
import {
  deriveSubkeyBytes,
  deriveSubkeys,
  emailId,
  hmacHex,
  SUBKEY_LABELS,
  verifyHmacHex,
} from "./subkeys.js";

const SECRET = new TextEncoder().encode("0123456789abcdef0123456789abcdef");

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("HKDF subkeys (09 §1.1)", () => {
  it("uses exactly the spec's labels", () => {
    expect(Object.values(SUBKEY_LABELS)).toEqual([
      "otp/v1",
      "ip/v1",
      "unsub/v1",
      "email-id/v1",
      "token/v1",
    ]);
  });

  // Known answers computed independently (Node's crypto.hkdfSync, SHA-256, empty salt). A change
  // here silently invalidates stored hashes (09 §1.1): it must never happen by accident.
  it.each([
    ["otp/v1", "313dd827d99c26f05d3e6793b87e5abd2539aa70a87ffdc6de3a018777213963"],
    ["ip/v1", "7cf93fecedd82241f3c89304b77159d3a9a3ea791c0d9126ba6f6556fa5ad22b"],
    ["unsub/v1", "db323d30dd1c839907761b86db180d77a111c1dd0172638096c1e026113b64d3"],
    ["email-id/v1", "81dbc08d6966b3c07a7ca951620b384505c3c6cdba860bb5e03140956889812c"],
    ["token/v1", "8d00e8e9c88b509b881421a7258b4d38806a639a4264fcc3628350e348a6e91e"],
  ])("derives %s deterministically", async (label, expected) => {
    expect(hex(await deriveSubkeyBytes(SECRET, label))).toBe(expected);
  });

  it("gives every label a different key, and a different secret different keys", async () => {
    const labels = Object.values(SUBKEY_LABELS);
    const keys = await Promise.all(labels.map((label) => deriveSubkeyBytes(SECRET, label)));
    expect(new Set(keys.map(hex)).size).toBe(labels.length);
    const other = new TextEncoder().encode("fedcba9876543210fedcba9876543210");
    expect(hex(await deriveSubkeyBytes(other, "otp/v1"))).not.toBe(hex(keys[0] ?? SECRET));
  });

  it("derives non-extractable HMAC keys", async () => {
    const keys = await deriveSubkeys(SECRET);
    expect(Object.keys(keys).sort()).toEqual(Object.keys(SUBKEY_LABELS).sort());
    for (const key of Object.values(keys)) {
      expect(key.extractable).toBe(false);
      expect(key.algorithm).toMatchObject({ name: "HMAC" });
      expect(key.usages.sort()).toEqual(["sign", "verify"]);
    }
  });

  it("computes emailId as HMAC-SHA256 under email-id/v1", async () => {
    const keys = await deriveSubkeys(SECRET);
    expect(await emailId(keys, "alex@example.org" as NormalisedEmail)).toBe(
      "23166a32736ea9a694bf81440f6f26376a16e97eb5932f70b16853f6b8ef7bf6",
    );
    // Not the same MAC under another subkey.
    expect(await hmacHex(keys.otp, "alex@example.org")).not.toBe(
      await emailId(keys, "alex@example.org" as NormalisedEmail),
    );
  });

  it("verifies a digest and refuses wrong or malformed ones", async () => {
    const keys = await deriveSubkeys(SECRET);
    const message = new TextEncoder().encode("challenge-12345678");
    const digest = await hmacHex(keys.otp, message);
    expect(await verifyHmacHex(keys.otp, message, digest)).toBe(true);
    expect(await verifyHmacHex(keys.otp, "challenge-12345679", digest)).toBe(false);
    expect(await verifyHmacHex(keys.token, message, digest)).toBe(false);
    const flipped = `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
    expect(await verifyHmacHex(keys.otp, message, flipped)).toBe(false);
    expect(await verifyHmacHex(keys.otp, message, digest.toUpperCase())).toBe(false);
    expect(await verifyHmacHex(keys.otp, message, digest.slice(2))).toBe(false);
  });
});

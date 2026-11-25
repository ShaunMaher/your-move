/** Unsubscribe tokens (docs/spec/05-api.md §Email links, 08 T17). */
import { beforeAll, describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url } from "../base64.js";
import { deriveSubkeys, type Subkeys } from "../crypto/subkeys.js";
import { unsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from "./unsubscribe-token.js";

const EMAIL_ID = "0123456789abcdef".repeat(4);
let keys: Subkeys;
let otherKeys: Subkeys;

beforeAll(async () => {
  keys = await deriveSubkeys(new TextEncoder().encode("0123456789abcdef0123456789abcdef"));
  otherKeys = await deriveSubkeys(new TextEncoder().encode("fedcba9876543210fedcba9876543210"));
});

/** A token over any payload, MAC'd with the real key: what a forger who had the key could make. */
async function signed(payload: string, with_: Subkeys = keys): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", with_.unsub, bytes));
  return toBase64Url(new Uint8Array([...bytes, ...mac]));
}

describe("unsubscribe tokens", () => {
  it.each(["nudges", "invites"] as const)("round-trips a %s token", async (purpose) => {
    const token = await unsubscribeToken(keys, { purpose, emailId: EMAIL_ID });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(await verifyUnsubscribeToken(keys, token)).toEqual({ purpose, emailId: EMAIL_ID });
  });

  it("carries the purpose inside the MAC: changing it breaks the token", async () => {
    const invites = fromBase64Url(
      await unsubscribeToken(keys, { purpose: "invites", emailId: EMAIL_ID }),
    );
    const nudges = new TextEncoder().encode(
      JSON.stringify({ v: 1, purpose: "nudges", emailId: EMAIL_ID }),
    );
    const swapped = toBase64Url(new Uint8Array([...nudges, ...invites.slice(-32)]));
    expect(await verifyUnsubscribeToken(keys, swapped)).toBeNull();
  });

  it("refuses every flipped byte, of the payload and of the MAC", async () => {
    const bytes = fromBase64Url(
      await unsubscribeToken(keys, { purpose: "nudges", emailId: EMAIL_ID }),
    );
    for (let i = 0; i < bytes.length; i++) {
      const tampered = bytes.slice();
      tampered[i] = (tampered[i] ?? 0) ^ 1;
      expect(await verifyUnsubscribeToken(keys, toBase64Url(tampered))).toBeNull();
    }
  });

  it("refuses a token made with another secret", async () => {
    const token = await unsubscribeToken(otherKeys, { purpose: "nudges", emailId: EMAIL_ID });
    expect(await verifyUnsubscribeToken(keys, token)).toBeNull();
  });

  it("never contains the address or anything but the emailId", async () => {
    const token = await unsubscribeToken(keys, { purpose: "nudges", emailId: EMAIL_ID });
    const payload = new TextDecoder().decode(fromBase64Url(token).slice(0, -32));
    expect(JSON.parse(payload)).toEqual({ v: 1, purpose: "nudges", emailId: EMAIL_ID });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["padded", "QUJD=="],
    ["standard base64", "ab+/"],
    ["too long", "A".repeat(513)],
    ["only a MAC", toBase64Url(new Uint8Array(32))],
    ["not base64", "%%%"],
  ])("refuses a %s token", async (_name, token) => {
    expect(await verifyUnsubscribeToken(keys, token)).toBeNull();
  });

  it.each([
    ["another version", `{"v":2,"purpose":"nudges","emailId":"${EMAIL_ID}"}`],
    ["an unknown purpose", `{"v":1,"purpose":"everything","emailId":"${EMAIL_ID}"}`],
    ["an extra key", `{"v":1,"purpose":"nudges","emailId":"${EMAIL_ID}","email":"a@b.c"}`],
    ["upper-case hex", `{"v":1,"purpose":"nudges","emailId":"${EMAIL_ID.toUpperCase()}"}`],
    ["a short emailId", `{"v":1,"purpose":"nudges","emailId":"abc"}`],
    ["not JSON", "nudges"],
    ["an array", "[1]"],
  ])("refuses a correctly MAC'd payload with %s", async (_name, payload) => {
    expect(await verifyUnsubscribeToken(keys, await signed(payload))).toBeNull();
  });

  it("refuses a correctly MAC'd payload that isn't UTF-8", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", keys.unsub, bytes));
    expect(
      await verifyUnsubscribeToken(keys, toBase64Url(new Uint8Array([...bytes, ...mac]))),
    ).toBeNull();
  });

  it("builds the link under PUBLIC_URL", () => {
    expect(unsubscribeUrl("https://play.example.org", "abc_-")).toBe(
      "https://play.example.org/api/v1/email/unsubscribe?t=abc_-",
    );
  });
});

/** Web Push encryption against RFC 8291's worked example (§5, Appendix A), and a round trip. */
import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url } from "../base64.js";
import { decryptPushMessage, testClientKeys } from "./decrypt.js";
import { encryptPushMessage, freshEphemeralKeys, MAX_PLAINTEXT_BYTES } from "./encrypt.js";

const bytes = (value: string) => new Uint8Array(fromBase64Url(value));

/** RFC 8291 Appendix A. */
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  /** §5: the whole message body. */
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** An ECDH private key from its scalar and public point. */
function importPrivate(scalar: string, point: string): Promise<CryptoKey> {
  const p = bytes(point);
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: scalar,
      x: toBase64Url(p.slice(1, 33)),
      y: toBase64Url(p.slice(33)),
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

describe("encryptPushMessage (RFC 8291)", () => {
  it("produces the RFC's example body from its keys and salt", async () => {
    const body = await encryptPushMessage(
      bytes(RFC.plaintext),
      { p256dh: bytes(RFC.uaPublic), auth: bytes(RFC.auth) },
      {
        privateKey: await importPrivate(RFC.asPrivate, RFC.asPublic),
        publicKey: bytes(RFC.asPublic),
        salt: bytes(RFC.salt),
      },
    );
    expect(toBase64Url(body)).toBe(RFC.body);
  });

  it("decrypts the RFC's example body with the user agent's keys", async () => {
    const plaintext = await decryptPushMessage(bytes(RFC.body), {
      privateKey: await importPrivate(RFC.uaPrivate, RFC.uaPublic),
      publicKey: bytes(RFC.uaPublic),
      auth: bytes(RFC.auth),
    });
    expect(new TextDecoder().decode(plaintext)).toBe("When I grow up, I want to be a watermelon");
  });

  it("uses a fresh key pair and salt for every message, each readable by the device", async () => {
    const client = await testClientKeys();
    const message = new TextEncoder().encode('{"title":"t"}');
    const keys = { p256dh: client.publicKey, auth: client.auth };
    const first = await encryptPushMessage(message, keys, await freshEphemeralKeys());
    const second = await encryptPushMessage(message, keys, await freshEphemeralKeys());
    expect(toBase64Url(first.slice(0, 16))).not.toBe(toBase64Url(second.slice(0, 16)));
    expect(toBase64Url(first.slice(21, 86))).not.toBe(toBase64Url(second.slice(21, 86)));
    for (const body of [first, second]) {
      // The header: salt, record size 4096, a 65-byte key id.
      expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
      expect(body[20]).toBe(65);
      expect(new TextDecoder().decode(await decryptPushMessage(body, client))).toBe(
        '{"title":"t"}',
      );
    }
  });

  it("refuses a message too long for a push service", async () => {
    const client = await testClientKeys();
    const keys = { p256dh: client.publicKey, auth: client.auth };
    const fits = await encryptPushMessage(
      new Uint8Array(MAX_PLAINTEXT_BYTES),
      keys,
      await freshEphemeralKeys(),
    );
    expect(fits.length).toBe(4096);
    await expect(
      encryptPushMessage(new Uint8Array(MAX_PLAINTEXT_BYTES + 1), keys, await freshEphemeralKeys()),
    ).rejects.toThrow(RangeError);
  });
});

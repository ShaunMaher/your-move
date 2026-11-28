/** The push endpoint allow-list and key checks (08 T12). */
import { describe, expect, it } from "vitest";

import { toBase64Url } from "../base64.js";
import { TEST_VAPID } from "../test-support.js";
import { parseEndpoint, parseKeys } from "./endpoint.js";

describe("parseEndpoint (08 T12)", () => {
  it.each([
    // The spec's own examples.
    ["https://x.push.apple.com/abc", true],
    ["https://evilpush.apple.com/abc", false],
    ["https://push.apple.com.evil.tld/abc", false],
    // Each allow-listed service, exactly and below a label boundary.
    ["https://push.apple.com/abc", true],
    ["https://web.push.apple.com/QGx", true],
    ["https://fcm.googleapis.com/fcm/send/abc:def", true],
    ["https://updates.push.services.mozilla.com/wpush/v2/gAAA", true],
    ["https://wns2-par02p.notify.windows.com/w/?token=BQYAAA%2b", true],
    ["https://a.b.fcm.googleapis.com/x", true],
    // Look-alikes and other hosts.
    ["https://googleapis.com/fcm/send/abc", false],
    ["https://fcm.googleapis.com.example.org/x", false],
    ["https://xfcm.googleapis.com/x", false],
    ["https://apple.com/x", false],
    ["https://example.org/x", false],
    ["https://push.apple.co/x", false],
    // Scheme, userinfo and ports.
    ["http://web.push.apple.com/abc", false],
    ["wss://web.push.apple.com/abc", false],
    ["https://user@web.push.apple.com/abc", false],
    ["https://user:pass@web.push.apple.com/abc", false],
    ["https://:pass@web.push.apple.com/abc", false],
    ["https://web.push.apple.com:443/abc", true],
    ["https://web.push.apple.com:8443/abc", false],
    ["https://web.push.apple.com:80/abc", false],
    ["https://web.push.apple.com:0443/abc", true],
    // Case, trailing dots, punycode and look-alike characters.
    ["https://WEB.PUSH.APPLE.COM/abc", true],
    ["https://web.push.apple.com./abc", false],
    ["https://web.push.apple.com../abc", false],
    ["https://web.push.аpple.com/abc", false], // Cyrillic "а"
    ["https://xn--web-push.apple.com/abc", false],
    ["https://x.xn--pple-43d.com/abc", false],
    ["https://web.push.apple.com%2eevil.tld/abc", false],
    ["https://evil.tld\\@web.push.apple.com/abc", false],
    // IP literals.
    ["https://17.0.0.1/abc", false],
    ["https://0x7f.1/abc", false],
    ["https://2130706433/abc", false],
    ["https://[::1]/abc", false],
    ["https://[2001:db8::1]/abc", false],
    ["https://[::ffff:17.0.0.1]/abc", false],
    // Fragments, garbage and size.
    ["https://web.push.apple.com/abc#frag", false],
    ["https://web.push.apple.com/abc#", false],
    ["web.push.apple.com/abc", false],
    ["", false],
    [`https://web.push.apple.com/${"a".repeat(2048)}`, false],
  ])("%s → %s", (endpoint, allowed) => {
    expect(parseEndpoint(endpoint) !== null).toBe(allowed);
  });

  it("returns the parsed URL, which is what gets stored and posted to", () => {
    expect(parseEndpoint("https://WEB.Push.Apple.com:443/abc")?.href).toBe(
      "https://web.push.apple.com/abc",
    );
  });
});

describe("parseKeys (08 T12)", () => {
  const auth = toBase64Url(new Uint8Array(16).fill(7));

  it("accepts a P-256 point and a 16-byte auth secret", async () => {
    expect(await parseKeys({ p256dh: TEST_VAPID.publicKey, auth })).not.toBeNull();
  });

  it.each([
    [
      "a point off the curve",
      toBase64Url(new Uint8Array([4, ...new Uint8Array(64).fill(1)])),
      auth,
    ],
    ["a compressed point", toBase64Url(new Uint8Array([2, ...new Uint8Array(32).fill(1)])), auth],
    ["a 64-byte key", toBase64Url(new Uint8Array(64).fill(4)), auth],
    ["a padded key", `${TEST_VAPID.publicKey}=`, auth],
    ["a 15-byte auth", TEST_VAPID.publicKey, toBase64Url(new Uint8Array(15))],
    ["a 17-byte auth", TEST_VAPID.publicKey, toBase64Url(new Uint8Array(17))],
    ["a non-base64url auth", TEST_VAPID.publicKey, "!!!!!!!!!!!!!!!!!!!!!!"],
    ["empty keys", "", ""],
  ])("refuses %s", async (_name, p256dh, authSecret) => {
    expect(await parseKeys({ p256dh, auth: authSecret })).toBeNull();
  });
});

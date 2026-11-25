import { describe, expect, it } from "vitest";

import { normaliseDisplayName, validateDisplayName } from "./display-name.js";
import { MAX_EMAIL_LENGTH, normaliseAddress } from "./email.js";

describe("normaliseAddress (04 conventions)", () => {
  it.each([
    ["Sam@Example.ORG", "sam@example.org"],
    ["  sam+games@example.org\t", "sam+games@example.org"],
    ["first.last@sub.example.co.uk", "first.last@sub.example.co.uk"],
    ["Ånne@example.org".normalize("NFD"), "ånne@example.org"],
    // The stored domain is ASCII: an internationalised one is stored as punycode (09 §2).
    ["x@bücher.de", "x@xn--bcher-kva.de"],
    ["x@BÜCHER.de", "x@xn--bcher-kva.de"],
    ["x@bu\u0308cher.de", "x@xn--bcher-kva.de"],
  ])("%j → %s", (input, expected) => {
    expect(normaliseAddress(input)).toBe(expected);
  });

  it.each([
    "",
    "sam",
    "sam@",
    "@example.org",
    "sam@example",
    "sam@@example.org",
    "sam @example.org",
    "sam@exa mple.org",
    "Sam <sam@example.org>",
    "sam@example.org\r\nBcc: x@example.org",
    "sam@example.org,other@example.org",
    '"sam"@example.org',
    "sam@[192.0.2.1]",
    "sam@example..org",
    "sam\u0000@example.org",
    `${"a".repeat(65)}@example.org`,
    // A domain a URL parser would rewrite into something else is never stored (A5-S-3).
    "x@gmail.com#é",
    "x@gmail.com/é",
    "x@gmail.com?é",
    "x@ｇｍａｉｌ.com",
    "x@gma%69l.cömx",
    "x@gmail.com%2F.é.de",
    "x@a_b.example",
    "x@-a.example",
    "x@a-.example",
    "x@exämple。org",
    "x@xn--bcher-kva.de\u00e9\u0000",
  ])("refuses %j", (input) => {
    expect(normaliseAddress(input)).toBeNull();
  });

  it(`refuses addresses longer than ${String(MAX_EMAIL_LENGTH)} characters`, () => {
    const domain = `${"d".repeat(100)}.${"e".repeat(100)}.${"f".repeat(100)}.org`;
    expect(normaliseAddress(`a@${domain}`)).toBeNull();
  });
});

describe("display names (06 §5.1)", () => {
  it("normalises: NFC, trimmed, whitespace collapsed", () => {
    expect(normaliseDisplayName("  Sam \u{A0} \u{2003}Smith ")).toBe("Sam Smith");
    expect(normaliseDisplayName("Cafe\u{301}")).toBe("Caf\u{E9}");
  });

  it.each([
    "Sam",
    "Zoë",
    "李小龙",
    "🇦🇺 Aussie",
    "a".repeat(24),
    "R2-D2",
    "Mum 123456",
    "Mum \u{1F469}\u{200D}\u{1F467}",
    "Pride \u{1F3F3}\u{FE0F}\u{200D}\u{1F308}",
    "\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB} coder",
  ])("accepts %j", (name) => {
    expect(validateDisplayName(name, "Family Games").ok).toBe(true);
  });

  it.each([
    ["", "length"],
    ["   ", "length"],
    ["a".repeat(25), "length"],
    ["q\u{301}\u{302}\u{303}", "combining"],
    ["a\u{200D}b", "characters"],
    ["Sam\u{2028}Smith", "characters"],
    ["Sam\u{2029}Smith", "characters"],
    ["Mum \u{200D}\u{1F467}", "characters"],
    ["Sam\tSmith", "characters"],
    ["Sam\u{202E}x", "characters"],
    ["Sam\u{2066}x", "characters"],
    ["Sam\u{200B}x", "characters"],
    ["Sam\u{FEFF}x", "characters"],
    ["Sam\u0007", "characters"],
    ["Sam\nBcc: x", "characters"],
    ["http://x", "link"],
    ["www.x", "link"],
    ["me@home", "link"],
    ["shop.com", "link"],
    ["Visit Example.Org", "link"],
    ["1234567", "digits"],
    ["Family Games fan", "reserved"],
    ["ADMIN", "reserved"],
    ["Support", "reserved"],
    ["the official one", "reserved"],
    ["staffer", "reserved"],
  ])("refuses %j (%s)", (name, reason) => {
    expect(validateDisplayName(name, "Family Games")).toEqual({ ok: false, reason });
  });

  it("counts graphemes, not code points, but caps code points at 64", () => {
    // "q" and two combining marks: one grapheme of 3 code points (no precomposed form).
    const heavy = "q" + String.fromCodePoint(0x301, 0x302);
    expect(validateDisplayName(heavy.repeat(21), "X").ok).toBe(true);
    expect(validateDisplayName(heavy.repeat(22), "X")).toEqual({ ok: false, reason: "length" });
  });
});

import { describe, expect, it } from "vitest";

import { buildMime, EXTRA_HEADERS, type MimeInput, quotedPrintable } from "./mime.js";
import { EmailHeaderError } from "./sender.js";

const base: MimeInput = {
  from: { name: "Example Games", address: "no-reply@example.org" },
  to: "sam@example.org",
  subject: "12345678 is your Example Games sign-in code",
  text: "Your code is: 1234 5678\n",
  html: "<p>Your code is: 1234 5678</p>",
  date: new Date(0),
  messageId: "abc-123@example.org",
};

/** Splits a built message into unfolded headers (in order) and the body. */
function parse(raw: string): { headers: [string, string][]; body: string } {
  expect(raw).not.toMatch(/(?<!\r)\n/u);
  const split = raw.indexOf("\r\n\r\n");
  const lines = raw.slice(0, split).split("\r\n");
  const headers: [string, string][] = [];
  for (const line of lines) {
    if (/^[ \t]/u.test(line)) {
      const last = headers.at(-1);
      if (last === undefined) throw new Error("fold before any header");
      last[1] += line;
    } else {
      const colon = line.indexOf(":");
      headers.push([line.slice(0, colon), line.slice(colon + 1).trimStart()]);
    }
  }
  return { headers, body: raw.slice(split + 4) };
}

function header(raw: string, name: string): string {
  const found = parse(raw).headers.filter(([key]) => key === name);
  expect(found).toHaveLength(1);
  return found[0]?.[1] ?? "";
}

/** Decodes RFC 2047 B words (joined by folding whitespace) back to text. */
function decodeWords(value: string): string {
  const words = [...value.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/gu)];
  expect(words.map((word) => word[0]).join(" ")).toBe(value.replaceAll(/\s+/gu, " "));
  return words
    .map((word) =>
      new TextDecoder().decode(Uint8Array.from(atob(word[1] ?? ""), (c) => c.charCodeAt(0))),
    )
    .join("");
}

/** Line ends as the builder writes them. */
function crlf(text: string): string {
  return text.replaceAll(/\r\n|\r|\n/gu, "\r\n");
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  const joined = value.replaceAll("=\r\n", "");
  for (let index = 0; index < joined.length; index++) {
    if (joined[index] === "=") {
      bytes.push(Number.parseInt(joined.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(joined.charCodeAt(index));
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

describe("buildMime", () => {
  it("writes the headers in order, ASCII, CRLF only, with a multipart/alternative body", () => {
    const raw = buildMime(base);
    expect(
      Array.from(raw, (character) => character.charCodeAt(0)).every((code) => code < 128),
    ).toBe(true);
    const { headers, body } = parse(raw);
    expect(headers.map(([name]) => name)).toEqual([
      "From",
      "To",
      "Subject",
      "Date",
      "Message-ID",
      "MIME-Version",
      "Content-Type",
    ]);
    expect(header(raw, "From")).toBe('"Example Games" <no-reply@example.org>');
    expect(header(raw, "To")).toBe("sam@example.org");
    expect(header(raw, "Subject")).toBe(base.subject);
    expect(header(raw, "Date")).toBe("Thu, 01 Jan 1970 00:00:00 +0000");
    expect(header(raw, "Message-ID")).toBe("<abc-123@example.org>");
    expect(body).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(body).toContain("Content-Type: text/html; charset=UTF-8");
    expect(body.trimEnd().endsWith("--=_ym_alt_boundary--")).toBe(true);
    expect(body.indexOf("text/plain")).toBeLessThan(body.indexOf("text/html"));
  });

  it("omits the display name when there is none", () => {
    expect(
      header(buildMime({ ...base, from: { name: null, address: "a@example.org" } }), "From"),
    ).toBe("a@example.org");
  });

  it("adds the allowed extra headers and nothing else", () => {
    const raw = buildMime({
      ...base,
      headers: {
        "List-Unsubscribe": "<https://play.example.org/api/v1/email/unsubscribe?t=x>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    expect(header(raw, "List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
    expect(EXTRA_HEADERS).toHaveLength(2);
    for (const name of ["Bcc", "Cc", "To", "Reply-To", "X-Anything", "list-unsubscribe"]) {
      expect(() => buildMime({ ...base, headers: { [name]: "x" } })).toThrow(EmailHeaderError);
    }
    expect(() => buildMime({ ...base, headers: { "List-Unsubscribe": "<é>" } })).toThrow(
      EmailHeaderError,
    );
    expect(() => buildMime({ ...base, headers: { "List-Unsubscribe": "<a>\r\nBcc: x" } })).toThrow(
      EmailHeaderError,
    );
  });
});

describe("hostile input (08 T14)", () => {
  const injected = [
    "Evil\r\nBcc: victim@example.org",
    "Evil\nBcc: victim@example.org",
    "Evil\rBcc: victim@example.org",
    "Evil\u0000",
    "Evil\u0085Bcc: x",
    "Evil\u007f",
    "Evil\tTab",
  ];

  it.each(injected)("refuses %j in a display name, a subject and an address", (value) => {
    expect(() => buildMime({ ...base, from: { name: value, address: base.from.address } })).toThrow(
      EmailHeaderError,
    );
    expect(() => buildMime({ ...base, subject: value })).toThrow(EmailHeaderError);
    expect(() => buildMime({ ...base, to: `a${value}@example.org` })).toThrow(EmailHeaderError);
    expect(() => buildMime({ ...base, from: { name: null, address: `a@${value}.org` } })).toThrow(
      EmailHeaderError,
    );
    expect(() => buildMime({ ...base, messageId: `${value}@example.org` })).toThrow(
      EmailHeaderError,
    );
  });

  it("keeps a name that tries to close its quote and add a mailbox inside one From header", () => {
    const name = 'x" <evil@example.org>, "y\\';
    const raw = buildMime({ ...base, from: { name, address: base.from.address } });
    const value = header(raw, "From");
    expect(value).toBe('"x\\" <evil@example.org>, \\"y\\\\" <no-reply@example.org>');
    // Unquoting the phrase gives the name back; only one angle-addr follows it.
    const match = /^"((?:[^"\\]|\\.)*)" <([^<>]+)>$/u.exec(value);
    expect(match?.[2]).toBe("no-reply@example.org");
    expect(match?.[1]?.replaceAll(/\\(.)/gu, "$1")).toBe(name);
    expect(parse(raw).headers.map(([key]) => key)).not.toContain("Bcc");
  });

  it("encodes names and subjects that aren't printable ASCII as encoded words", () => {
    const name = "Zoë 李 🎲";
    const raw = buildMime({ ...base, from: { name, address: base.from.address }, subject: name });
    expect(decodeWords(header(raw, "From").replace(/ <[^>]+>$/u, ""))).toBe(name);
    expect(decodeWords(header(raw, "Subject"))).toBe(name);
  });

  it("splits very long names and subjects into short words without breaking a character", () => {
    const long = "é李🎲".repeat(400);
    const raw = buildMime({
      ...base,
      from: { name: long, address: base.from.address },
      subject: long,
    });
    for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    expect(decodeWords(header(raw, "Subject"))).toBe(long);
    expect(decodeWords(header(raw, "From").replace(/ <[^>]+>$/u, ""))).toBe(long);
  });

  it("encodes a long ASCII subject, one that looks like an encoded word, and Unicode line separators", () => {
    for (const subject of ["a".repeat(500), "=?UTF-8?B?QQ==?= hi", "a\u2028Bcc: x", "a\u2029b"]) {
      const raw = buildMime({ ...base, subject });
      expect(raw).not.toMatch(/[\u2028\u2029]/u);
      expect(parse(raw).headers.map(([key]) => key)).not.toContain("Bcc");
      expect(decodeWords(header(raw, "Subject"))).toBe(subject);
    }
  });

  it("refuses an address that isn't a plain ASCII addr-spec", () => {
    for (const to of [
      "a@example.org>, Bcc: b@example.org",
      "a b@example.org",
      "<a@example.org>",
      '"a"@example.org',
      "a(comment)@example.org",
      "a..b@example.org",
      ".a@example.org",
      "é@example.org",
      "a@example",
      "a@@example.org",
      "no-at-sign",
      `${"a".repeat(250)}@example.org`,
    ]) {
      expect(() => buildMime({ ...base, to })).toThrow(EmailHeaderError);
    }
  });

  it("converts an internationalised domain to punycode", () => {
    expect(header(buildMime({ ...base, to: "sam@bücher.example" }), "To")).toBe(
      "sam@xn--bcher-kva.example",
    );
  });

  it("refuses an invalid date and a malformed message id", () => {
    expect(() => buildMime({ ...base, date: new Date(Number.NaN) })).toThrow(EmailHeaderError);
    for (const messageId of ["no-at", "a b@example.org", "a@b>\r\nX: y", "<a@b>"]) {
      expect(() => buildMime({ ...base, messageId })).toThrow(EmailHeaderError);
    }
  });

  it("keeps hostile body text out of the headers: a body line like the boundary is encoded", () => {
    const text = `--=_ym_alt_boundary\r\nBcc: victim@example.org\r\n\r\nhi`;
    const raw = buildMime({ ...base, text });
    expect(raw.split("\r\n").filter((line) => line === "--=_ym_alt_boundary")).toHaveLength(2);
    const { body } = parse(raw);
    const plain = body.split("--=_ym_alt_boundary")[1] ?? "";
    expect(decodeQuotedPrintable(plain.slice(plain.indexOf("\r\n\r\n") + 4).trimEnd())).toBe(
      crlf(text),
    );
  });
});

describe("quotedPrintable", () => {
  it.each([
    "plain text",
    "equals = sign and =3D",
    "trailing space \nnext line\t\n",
    "non-ASCII: é李🎲",
    "long ".repeat(100),
    "é".repeat(200),
    "a".repeat(1000),
    "\n\n\nblank lines\n",
    "line with CRLF\r\nand CR\rand LF\n",
  ])("round-trips and keeps lines within 76 characters (case %#)", (text) => {
    const encoded = quotedPrintable(text);
    for (const line of encoded.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(encoded).toMatch(/^[ -~\r\n]*$/u);
    expect(decodeQuotedPrintable(encoded)).toBe(crlf(text));
  });

  it("encodes trailing whitespace so a gateway can't strip it", () => {
    expect(quotedPrintable("a \nb\t")).toBe("a=20\r\nb=09");
  });
});

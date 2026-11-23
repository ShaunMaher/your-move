import { describe, expect, it } from "vitest";

import { isEmailAddress, normaliseEmail, parseMailbox } from "./email.js";

describe("normaliseEmail", () => {
  it("trims, applies NFC and lower-cases", () => {
    expect(normaliseEmail("  Ana@Example.ORG ")).toBe("ana@example.org");
    expect(normaliseEmail("José@example.org")).toBe("josé@example.org");
  });
});

describe("isEmailAddress", () => {
  it.each([
    ["a@example.org", true],
    ["no-reply@localhost", true],
    ["a.b+c@sub.example.org", true],
    ["", false],
    ["a", false],
    ["a@", false],
    ["@example.org", false],
    ["a b@example.org", false],
    ["a@example.org,b@example.org", false],
    ["Name <a@example.org>", false],
  ])("%j → %s", (value, expected) => {
    expect(isEmailAddress(value)).toBe(expected);
  });
});

describe("parseMailbox", () => {
  it.each([
    ["a@example.org", { name: null, address: "a@example.org" }],
    [" a@example.org ", { name: null, address: "a@example.org" }],
    ["Games <a@example.org>", { name: "Games", address: "a@example.org" }],
    ['"Family Games" <a@example.org>', { name: "Family Games", address: "a@example.org" }],
    ["<a@example.org>", { name: null, address: "a@example.org" }],
  ])("parses %j", (value, expected) => {
    expect(parseMailbox(value)).toEqual(expected);
  });

  it.each([
    "",
    "Games",
    "Games <not-an-address>",
    "a@example.org\nBcc: b@example.org",
    "Games <a@example.org>\r",
    "a@example.org, b@example.org",
    "<a@example.org> trailing",
  ])("rejects %j", (value) => {
    expect(parseMailbox(value)).toBeNull();
  });
});

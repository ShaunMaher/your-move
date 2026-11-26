import { describe, expect, it } from "vitest";

import { fitAddresses, lastPlayed, looksLikeEmail } from "./text.js";

describe("looksLikeEmail", () => {
  it.each(["sam@example.org", " sam@example.org ", "a.b+c@mail.example.co.uk", "x@y.z"])(
    "accepts %s",
    (input) => {
      expect(looksLikeEmail(input)).toBe(true);
    },
  );

  it.each([
    "",
    "sam",
    "sam@",
    "@example.org",
    "sam@host",
    "sam@example.",
    "sam@.org",
    "sam@example..org",
    "sam@@example.org",
    "sam smith@example.org",
  ])("rejects %s", (input) => {
    expect(looksLikeEmail(input)).toBe(false);
  });
});

describe("fitAddresses (07 §1.1, A12-P-10)", () => {
  it("drops empty fields first, the latest first, then the latest typed ones", () => {
    expect(fitAddresses(["", "b@x.org", " "], 2)).toEqual(["", "b@x.org"]);
    expect(fitAddresses(["", "b@x.org", " "], 1)).toEqual(["b@x.org"]);
    expect(fitAddresses(["a@x.org", "b@x.org"], 1)).toEqual(["a@x.org"]);
    expect(fitAddresses(["a@x.org"], 3)).toEqual(["a@x.org", "", ""]);
    expect(fitAddresses(["a@x.org"], -1)).toEqual([]);
  });
});

describe("lastPlayed", () => {
  it("says when, as a date in the device's locale", () => {
    const at = Date.UTC(2026, 10, 26, 12);
    expect(lastPlayed(at)).toBe(
      `last played ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(at)}`,
    );
    expect(lastPlayed(at)).toContain("2026");
  });
});

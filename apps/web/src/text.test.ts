import { describe, expect, it } from "vitest";

import { looksLikeEmail } from "./text.js";

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

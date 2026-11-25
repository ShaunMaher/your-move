import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64, toBase64Url } from "./base64.js";

describe("base64", () => {
  it.each([0, 1, 2, 3, 4, 5])("round trips %i bytes", (length) => {
    const bytes = Uint8Array.from({ length }, (_, index) => 250 - index * 7);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(fromBase64Url(toBase64(bytes))).toEqual(bytes);
  });

  it("maps + and / to - and _ and drops the padding", () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0xfe, 0xfb]);
    expect(toBase64(bytes)).toBe("+//++w==");
    expect(toBase64Url(bytes)).toBe("-__--w");
  });

  it("accepts unpadded input", () => {
    expect(fromBase64Url("-__--w")).toEqual(Uint8Array.from([0xfb, 0xff, 0xfe, 0xfb]));
    expect(fromBase64Url("Zg")).toEqual(Uint8Array.from([0x66]));
  });

  it.each(["!!!!", "a", "Zg=x"])("throws on invalid input %j", (input) => {
    expect(() => fromBase64Url(input)).toThrow();
  });
});

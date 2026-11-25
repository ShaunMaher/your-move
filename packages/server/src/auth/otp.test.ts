import { describe, expect, it } from "vitest";

import { cleanCode, generateCode } from "./otp.js";

describe("generateCode (06 §3)", () => {
  it("is 8 digits, zero-padded", () => {
    const code = generateCode((buffer) => {
      buffer[0] = 42;
    });
    expect(code).toBe("00000042");
  });

  it("redraws values at or above the largest multiple of 10^8 below 2^32 (no modulo bias)", () => {
    const draws = [4_200_000_000, 4_294_967_295, 123];
    const code = generateCode((buffer) => {
      buffer[0] = draws.shift() ?? 0;
    });
    expect(code).toBe("00000123");
    expect(draws).toEqual([]);
  });

  it("accepts the largest unbiased value", () => {
    expect(
      generateCode((buffer) => {
        buffer[0] = 4_199_999_999;
      }),
    ).toBe("99999999");
  });

  it("uses WebCrypto by default", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateCode()));
    for (const code of codes) expect(code).toMatch(/^\d{8}$/u);
    expect(codes.size).toBeGreaterThan(45);
  });
});

describe("cleanCode (06 §3.3)", () => {
  it.each([
    ["1234 5678", "12345678"],
    ["1234-5678", "12345678"],
    [" 12345678\n", "12345678"],
  ])("%j → %s", (input, expected) => {
    expect(cleanCode(input)).toBe(expected);
  });
});

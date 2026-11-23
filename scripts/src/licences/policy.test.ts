import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ALLOWED_LICENCES, isAllowedExpression } from "./policy.js";

describe("isAllowedExpression", () => {
  it.each([...ALLOWED_LICENCES])("allows %s", (id) => {
    expect(isAllowedExpression(id)).toBe(true);
  });

  it.each([
    ["MIT OR Apache-2.0", true],
    ["(MIT OR Apache-2.0)", true],
    ["(MIT OR GPL-3.0-only)", true],
    ["GPL-3.0-only OR MIT", true],
    ["MIT AND ISC", true],
    ["MIT AND GPL-3.0-only", false],
    ["(MIT AND BSD-3-Clause) OR GPL-2.0-only", true],
    ["MIT AND (GPL-2.0-only OR Apache-2.0)", true],
    ["Apache-2.0+", true],
    ["mit or isc", false], // licence ids are case-sensitive in our list
    ["MIT or ISC", true], // operators are not
    ["GPL-3.0-only", false],
    ["MPL-2.0", false],
    ["LGPL-3.0-or-later", false],
    ["SEE LICENSE IN LICENSE.txt", false],
    ["UNLICENSED", false],
    ["Apache-2.0 WITH LLVM-exception", false],
    ["", false],
    ["   ", false],
    ["MIT OR", false],
    ["(MIT", false],
    ["MIT)", false],
    ["MIT ISC", false],
    ["AND", false],
    ["MIT, ISC", false],
  ])("%j → %s", (expression, expected) => {
    expect(isAllowedExpression(expression)).toBe(expected);
  });

  it("never throws and allows nothing outside the allow-list, whatever the input", () => {
    fc.assert(
      fc.property(fc.string(), (expression) => {
        const allowed = isAllowedExpression(expression);
        if (allowed) {
          const ids = expression.match(/[A-Za-z0-9.-]+/gu) ?? [];
          expect(ids.some((id) => ALLOWED_LICENCES.has(id))).toBe(true);
        }
      }),
    );
  });

  it("accepts an exception only when the exact pairing is allowed", () => {
    const allowed = new Set(["Apache-2.0 WITH LLVM-exception"]);
    expect(isAllowedExpression("Apache-2.0 WITH LLVM-exception", allowed)).toBe(true);
    expect(isAllowedExpression("Apache-2.0 WITH", allowed)).toBe(false);
    expect(isAllowedExpression("Apache-2.0 WITH (", allowed)).toBe(false);
  });
});

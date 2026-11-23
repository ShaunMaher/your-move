import { describe, expect, it } from "vitest";

import { findViolations, parseExceptions } from "./check.js";

const report = (entries: Record<string, string[]>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(entries).map(([licence, names]) => [
        licence,
        names.map((name) => ({ name, versions: ["1.0.0"], paths: [], license: licence })),
      ]),
    ),
  );

const DOC = `# Licences

Intro text | with a pipe.

## Accepted exceptions

| Package | Licence | Decision |
| --- | --- | --- |
| \`fixture-copyleft\` | GPL-3.0-only | 2026-11-23: accepted for testing |

## Something else

| other-package | MPL-2.0 | not an exception |
`;

describe("parseExceptions", () => {
  it("reads rows of the Accepted exceptions table only", () => {
    expect(parseExceptions(DOC)).toEqual([{ name: "fixture-copyleft", licence: "GPL-3.0-only" }]);
  });

  it("returns nothing when the section is missing", () => {
    expect(parseExceptions("# Licences\n")).toEqual([]);
  });
});

describe("findViolations", () => {
  it("passes allow-listed licences and expressions", () => {
    expect(
      findViolations(report({ MIT: ["a"], "MIT OR Apache-2.0": ["b"], ISC: ["c"] }), []),
    ).toEqual([]);
  });

  it("fails a disallowed licence (the gate's deliberate violation)", () => {
    expect(findViolations(report({ MIT: ["a"], "GPL-3.0-only": ["copyleft"] }), [])).toEqual([
      { name: "copyleft", versions: ["1.0.0"], licence: "GPL-3.0-only" },
    ]);
  });

  it("fails packages with no licence", () => {
    expect(findViolations(report({ Unknown: ["mystery"] }), [])).toHaveLength(1);
  });

  it("passes a disallowed licence recorded as an exception for that package and licence", () => {
    const exceptions = parseExceptions(DOC);
    expect(findViolations(report({ "GPL-3.0-only": ["fixture-copyleft"] }), exceptions)).toEqual(
      [],
    );
    expect(
      findViolations(report({ "GPL-2.0-only": ["fixture-copyleft"] }), exceptions),
    ).toHaveLength(1);
    expect(findViolations(report({ "GPL-3.0-only": ["other"] }), exceptions)).toHaveLength(1);
  });

  it("rejects a malformed report", () => {
    expect(() => findViolations('{"MIT": [{"nope": 1}]}', [])).toThrow();
  });
});

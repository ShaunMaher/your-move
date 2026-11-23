import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { ENGINE_GLOBALS, engineEslintConfig } from "./index.js";

const linter = new Linter({ configType: "flat" });
const config = [
  { languageOptions: { ecmaVersion: 2023, sourceType: "module" } } as const,
  ...engineEslintConfig(["**/*.js"]),
];

function messages(code: string): string[] {
  return linter.verify(code, config, "engine.js").map((message) => message.message);
}

describe("engineEslintConfig", () => {
  it("accepts pure code using allowed built-ins", () => {
    expect(
      messages(`
        export const score = (tiles) => tiles.map((t) => t.value).reduce((a, b) => a + b, 0);
        export const at = (ms) => new Date(ms).toISOString();
        export const parse = (s) => JSON.parse(s);
        export const max = Math.max(1, 2);
        export const set = new Set([1]);
      `),
    ).toEqual([]);
  });

  it.each([
    ["Math.random()", /Randomness comes from RandomSource/u],
    ["Date.now()", /time only as an argument/u],
    ["new Date()", /reads the clock/u],
    ["fetch('https://example.org')", /'fetch' is not defined/u],
    ["crypto.getRandomValues(new Uint8Array(1))", /'crypto' is not defined/u],
    ["setTimeout(() => 1, 0)", /'setTimeout' is not defined/u],
    ["performance.now()", /'performance' is not defined/u],
    ["process.env.SECRET", /'process' is not defined/u],
    ["globalThis.x", /globalThis is not on the engine globals allow-list/u],
    ["self.x", /'self' is not defined/u],
    ["window.x", /'window' is not defined/u],
    ["console.log(1)", /'console' is not defined/u],
    ["eval('1')", /'eval' is not defined|eval/u],
    ["new Function('return 1')", /'Function' is not defined|Function/u],
    ["WebAssembly.compile(new Uint8Array(0))", /'WebAssembly' is not defined/u],
    ["Promise.resolve(1)", /Promise is not on the engine globals allow-list/u],
    ["JSON.parse = (s) => s", /must not write to built-in objects/u],
    ["Array.prototype.shuffle = function () {}", /must not write to prototypes|extend/u],
    ["Object.prototype.x = 1", /must not write to prototypes|extend/u],
    ["typeof fetch", /'fetch' is not defined/u],
  ])("rejects %s", (code, expected) => {
    const found = messages(`export const x = () => ${code};`);
    expect(
      found.some((message) => expected.test(message)),
      found.join("\n"),
    ).toBe(true);
  });

  it("allows Date with an argument but not the clock", () => {
    expect(ENGINE_GLOBALS).toContain("Date");
    expect(ENGINE_GLOBALS).not.toContain("globalThis");
  });
});

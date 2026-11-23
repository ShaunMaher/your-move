import { Linter } from "eslint";
import { parser } from "typescript-eslint";
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
    ["Date()", /Date\(\) reads the clock/u],
    ["String(Date(0))", /Date\(\) reads the clock/u],
    ['Math["ran" + "dom"]()', /by computed access/u],
    ['JSON["parse"]', /by computed access/u],
    ["Reflect.apply(Math.max, undefined, [1])", /Reflect\.apply/u],
    ["Reflect.construct(Map, [])", /Reflect\.construct/u],
    ["Reflect.set(JSON, 'parse', String)", /Reflect\.set/u],
    ["Reflect.defineProperty(JSON, 'parse', {})", /Reflect\.defineProperty/u],
    ["Reflect.setPrototypeOf(Object.prototype, null)", /Reflect\.setPrototypeOf/u],
    ["Object.assign(Math, { random: () => 1 })", /must not write to built-in objects/u],
    ["Object.defineProperty(JSON, 'parse', {})", /must not write to built-in objects/u],
    ["Object.defineProperties(Math, {})", /must not write to built-in objects/u],
    ["Object.setPrototypeOf(Array.prototype, null)", /must not write to built-in objects/u],
    ["delete Math.max", /must not write to built-in objects/u],
    ['Reflect.get(Math, "random")', /Reflect\.get reaches/u],
    ['Reflect.getOwnPropertyDescriptor(Math, "random")', /Reflect\.getOwnPropertyDescriptor/u],
    [
      'Object.getOwnPropertyDescriptor(Math, "random")',
      /Object\.getOwnPropertyDescriptor reaches/u,
    ],
    ["Object.getOwnPropertyDescriptors({})", /Object\.getOwnPropertyDescriptors reaches/u],
    ["new Date(...[])", /with a spread/u],
    ['import("./other.js")', /import only statically/u],
    ["import(name)", /import only statically/u],
    ["import.meta.url", /import\.meta is host-provided/u],
    ["(() => 1).constructor", /constructors or prototypes/u],
    ['({})["__proto__"]', /constructors or prototypes/u],
    ["new Date(0)[`constructor`].now()", /constructors or prototypes/u],
    ["({})[`__proto__`]", /constructors or prototypes/u],
    [
      "(() => { const { constructor: C } = new Date(0); return C.now(); })()",
      /constructors or prototypes/u,
    ],
    [
      '(() => { const { "constructor": C } = new Date(0); return C; })()',
      /constructors or prototypes/u,
    ],
    [
      "(() => { const { [`constructor`]: C } = new Date(0); return C; })()",
      /constructors or prototypes/u,
    ],
    ["(({ __proto__: p }) => p)({})", /constructors or prototypes/u],
    ["Math", /Use Math by name/u],
    ["[Math][0].max(1)", /Use Math by name/u],
    ["Object.values(Math)", /Use Math by name/u],
    ["({ ...Reflect })", /Use Reflect by name/u],
    ["typeof Date", /Use Date by name/u],
    // The allowed value uses don't open writes by name.
    ["Number.prototype.x = 1", /must not write to prototypes/u],
    ["Number.parseFloat = (s) => s", /must not write to built-in objects/u],
    ["Object.assign(Number, { x: 1 })", /must not write to built-in objects/u],
    ["Error.prototype.x = 1", /must not write to prototypes/u],
    ["Error.captureStackTrace = () => 1", /must not write to built-in objects/u],
  ])("rejects %s", (code, expected) => {
    const found = messages(`export const x = () => ${code};`);
    expect(
      found.some((message) => expected.test(message)),
      found.join("\n"),
    ).toBe(true);
  });

  it.each([
    "const M = Math; export const r = () => M.max(1);",
    "const { max } = Math; export const m = max(1, 2);",
    "export const f = (n = Number) => n;",
    // Conversion functions: only as an array method's callback, never aliased or handed on.
    "const N = Number; export const p = N.prototype;",
    "const f = (n) => n; export const p = f(Number);",
    "export const s = [1].map(Math);",
    "export const s = [1].map(Object);",
    "export const s = [1].map(JSON);",
    "export const s = [1].map(Reflect);",
    "export const s = [1].map(Map);",
    "export const s = [1].map(...Number);",
    "export const s = [1].map((x) => x, Number);",
    "export const s = [1][`map`](Number);",
    "export const s = [1].reduce(Number);",
    // Heritage: error classes only.
    "export class M extends Map {}",
    "export class O extends Object {}",
    "export const E = class extends (Error, Math) {};",
  ])("rejects a built-in used as a value: %s", (code) => {
    expect(messages(code).join("\n")).toMatch(/by name \(a member, call or new\), not as a value/u);
  });

  it("refuses an aliased global the allow-list leaves off, whatever the form", () => {
    expect(messages("export const s = [1].map(Function);").join("\n")).toMatch(
      /'Function' is not defined|Function is not on/u,
    );
    expect(messages("export const s = [1].map(globalThis);").join("\n")).toMatch(
      /globalThis is not on the engine globals allow-list/u,
    );
    expect(messages("export const s = [1].map(eval);").join("\n")).toMatch(
      /eval is not on the engine globals allow-list/u,
    );
  });

  it("allows instanceof, error subclasses and conversion functions as array callbacks", () => {
    expect(
      messages(`
        export class InvalidMove extends Error {}
        export const Rejected = class extends RangeError {};
        export const isMap = (x) => x instanceof Map;
        export const isDate = (x) => x instanceof Date;
        export const numbers = ["1", "2"].map(Number);
        export const strings = [1, 2].map(String);
        export const present = [0, 1, null].filter(Boolean);
        export const any = [0, 1].some(Boolean);
        export const maybe = (xs) => xs?.map(Number);
      `),
    ).toEqual([]);
  });

  it("allows the primitive built-ins and a local binding that shadows a built-in's name", () => {
    expect(
      messages(`
        export const values = [undefined, NaN, Infinity];
        export const local = (Math) => Math;
      `),
    ).toEqual([]);
  });

  it("lets TypeScript name built-ins in type positions, but not use them as values", () => {
    const typescript = [
      { languageOptions: { parser, sourceType: "module" } } as const,
      ...engineEslintConfig(["**/*.ts"]),
    ];
    const found = linter.verify(
      `
        export const cells = new Map<string, number>();
        export type Random = typeof Math.random;
        export type Builtin = typeof Math;
        export const lookup: ReadonlyMap<string, Date> = cells as never;
        export const bad = Math;
        export const cast = (Math as { random(): number }).random;
      `,
      typescript,
      "engine.ts",
    );
    expect(found.map((message) => `${String(message.line)}: ${message.message}`)).toEqual([
      "6: Use Math by name (a member, call or new), not as a value.",
      "7: Use Math by name (a member, call or new), not as a value.",
    ]);
  });

  it("allows template-literal keys with expressions and ordinary destructuring", () => {
    expect(
      messages(`
        const board = { cells: [1, 2], size: 2 };
        const key = "cells";
        export const cells = board[\`\${key}\`];
        export const { size, cells: list } = board;
      `),
    ).toEqual([]);
  });

  it("allows ordinary uses of the same names", () => {
    expect(
      messages(`
        const board = { cells: [1, 2] };
        export const merged = Object.assign({}, board, { size: 2 });
        export const cell = board.cells[0];
        export const max = Math.max(...board.cells);
        export const keys = Reflect.ownKeys(board);
      `),
    ).toEqual([]);
  });

  it("parses engine code as a module (strict mode)", () => {
    expect(messages("with (Math) { max(1, 2); }").join("\n")).toMatch(/strict mode|Parsing error/u);
  });

  it("allows Date with an argument but not the clock", () => {
    expect(ENGINE_GLOBALS).toContain("Date");
    expect(ENGINE_GLOBALS).not.toContain("globalThis");
  });
});

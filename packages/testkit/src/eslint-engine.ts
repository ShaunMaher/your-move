/**
 * The ESLint rules for game engine and manifest code (docs/spec/02-game-framework.md §7.5,
 * 11-engineering.md §5): a **globals allow-list** and no writes to built-in objects. Engines are
 * pure — randomness, clocks, timers, network and crypto reach them only as arguments — so anything
 * not on the list is an error. dependency-cruiser can't see globals; this can.
 *
 * Used by this repository's ESLint config on engine sources; `pnpm games:verify` runs it on built
 * engine and manifest output from M1. Erasable TypeScript only (loaded directly by Node).
 *
 * @packageDocumentation
 */
import type { Linter } from "eslint";
import globals from "globals";

/**
 * ECMAScript built-ins an engine may use. Deliberately absent: everything host-provided (`fetch`,
 * `crypto`, timers, `performance`, `process`, `console`, DOM), anything that runs strings as code
 * (`eval`, `Function`) or other code (`WebAssembly`), the global object itself (`globalThis`,
 * `self`), `Promise` (engines are synchronous), locale- or GC-dependent behaviour (`Intl`,
 * `WeakRef`, `FinalizationRegistry`) and `Proxy`.
 *
 * @public
 */
export const ENGINE_GLOBALS: readonly string[] = [
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "Error",
  "EvalError",
  "Float32Array",
  "Float64Array",
  "Infinity",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "RangeError",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "WeakMap",
  "WeakSet",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "undefined",
];

/** ECMAScript built-ins ESLint predefines that are not on the allow-list. */
const FORBIDDEN_BUILT_INS = Object.keys(globals.builtin).filter(
  (name) => !ENGINE_GLOBALS.includes(name),
);

/** Built-ins whose properties or prototypes an engine must never assign to. */
const BUILT_IN_OBJECTS = ENGINE_GLOBALS.filter((name) => /^[A-Z]/u.test(name)).join("|");

/**
 * Flat-config entries applying the engine rules to `files`.
 *
 * @public
 */
export function engineEslintConfig(files: readonly string[]): Linter.Config[] {
  return [
    {
      name: "@your-move/testkit/eslint-engine",
      files: [...files],
      languageOptions: {
        // Built engine output is ESM, hence strict mode: no sloppy-mode `this` as the global.
        sourceType: "module",
        globals: Object.fromEntries(ENGINE_GLOBALS.map((name) => [name, "readonly"])),
      },
      rules: {
        // The allow-list: any host global not listed above is undefined here, and the
        // ECMAScript built-ins left off the list are restricted.
        "no-undef": ["error", { typeof: true }],
        "no-restricted-globals": [
          "error",
          ...FORBIDDEN_BUILT_INS.map((name) => ({
            name,
            message: `${name} is not on the engine globals allow-list.`,
          })),
        ],
        "no-restricted-properties": [
          "error",
          { object: "Math", property: "random", message: "Randomness comes from RandomSource." },
          { object: "Date", property: "now", message: "Engines get time only as an argument." },
          ...[
            "construct",
            "set",
            "defineProperty",
            "deleteProperty",
            "setPrototypeOf",
            "apply",
          ].map((property) => ({
            object: "Reflect",
            property,
            message: `Reflect.${property} can call or rewrite built-ins indirectly; engines don't need it.`,
          })),
        ],
        "no-restricted-syntax": [
          "error",
          {
            selector: "NewExpression[callee.name='Date'][arguments.length=0]",
            message: "new Date() reads the clock; engines get time only as an argument.",
          },
          {
            selector: "CallExpression[callee.name='Date']",
            message: "Date() reads the clock; engines get time only as an argument.",
          },
          {
            selector: `MemberExpression[computed=true][object.name=/^(${BUILT_IN_OBJECTS})$/]`,
            message: "Use built-ins' members by name, not by computed access.",
          },
          {
            selector: `AssignmentExpression > MemberExpression.left[object.name=/^(${BUILT_IN_OBJECTS})$/]`,
            message: "Engines must not write to built-in objects.",
          },
          {
            selector: `UnaryExpression[operator='delete'] > MemberExpression[object.name=/^(${BUILT_IN_OBJECTS})$/]`,
            message: "Engines must not write to built-in objects.",
          },
          ...["[arguments.0.name", "[arguments.0.object.name"].map((target) => ({
            selector: `CallExpression[callee.object.name='Object'][callee.property.name=/^(assign|defineProperty|defineProperties|setPrototypeOf)$/]${target}=/^(${BUILT_IN_OBJECTS})$/]`,
            message: "Engines must not write to built-in objects.",
          })),
          {
            selector: `AssignmentExpression > MemberExpression.left > MemberExpression.object[property.name='prototype']`,
            message: "Engines must not write to prototypes.",
          },
        ],
        "no-extend-native": "error",
        "no-global-assign": "error",
        "no-eval": "error",
        "no-new-func": "error",
        "no-implied-eval": "error",
      },
    },
  ];
}

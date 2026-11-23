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
import type { Linter, Rule, Scope } from "eslint";
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

/** Built-in values that are primitives, not objects: using them as values exposes nothing. */
const PRIMITIVE_GLOBALS: ReadonlySet<string> = new Set(["Infinity", "NaN", "undefined"]);

/** Whether `identifier` is used only to reach a member, or to call or construct the built-in. */
function namedUse(identifier: Rule.Node): boolean {
  const parent = identifier.parent as Partial<{ type: string; object: unknown; callee: unknown }>;
  switch (parent.type) {
    // TypeScript's `typeof Math` and `typeof Math.random` in a type position are erased at compile
    // time (`Math as T` is not: it is still the value).
    case "TSTypeQuery":
    case "TSQualifiedName":
      return true;
    case "MemberExpression":
      return parent.object === identifier;
    case "CallExpression":
    case "NewExpression":
      return parent.callee === identifier;
    default:
      return false;
  }
}

/**
 * Built-in objects and functions are used by name only: as `Math.max(…)`, `Number(…)` or
 * `new Map()`, never as values (`const M = Math`, `f(Math)`, `{ ...Math }`, `const { random } =
 * Math`). The member and call rules below can only see uses by name.
 */
const noBuiltInValues: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Use engine built-ins by name only, never as values." },
    schema: [],
    messages: {
      value: "Use {{name}} by name (a member, call or new), not as a value.",
    },
  },
  create(context) {
    const check = (variable: Scope.Variable) => {
      if (!ENGINE_GLOBALS.includes(variable.name) || PRIMITIVE_GLOBALS.has(variable.name)) return;
      for (const reference of variable.references) {
        // TypeScript sources: a type position (`Map<K, V>`, `typeof Math`) names no runtime value.
        if ((reference as { isValueReference?: boolean }).isValueReference === false) continue;
        const identifier = reference.identifier as Rule.Node;
        if (!namedUse(identifier)) {
          context.report({ node: identifier, messageId: "value", data: { name: variable.name } });
        }
      }
    };
    return {
      "Program:exit"(node) {
        // Configured globals: variables of the global scope that nothing in the file declares.
        context.sourceCode
          .getScope(node)
          .variables.filter((variable) => variable.defs.length === 0)
          .forEach(check);
      },
    };
  },
};

/** Keys that lead from a value to its constructor or prototype. */
const PROTO_KEYS = "/^(constructor|__proto__)$/";

/** Attribute selectors for `field` being a template literal without expressions naming a PROTO_KEY. */
function staticTemplateKey(field: string): string {
  return `[${field}.type='TemplateLiteral'][${field}.expressions.length=0][${field}.quasis.0.value.cooked=${PROTO_KEYS}]`;
}

/** Members whose only engine use would be to reach a built-in's internals indirectly. */
const RESTRICTED_MEMBERS: readonly { object: string; property: string }[] = [
  ...[
    "apply",
    "construct",
    "defineProperty",
    "deleteProperty",
    "get",
    "getOwnPropertyDescriptor",
    "set",
    "setPrototypeOf",
  ].map((property) => ({ object: "Reflect", property })),
  ...["getOwnPropertyDescriptor", "getOwnPropertyDescriptors"].map((property) => ({
    object: "Object",
    property,
  })),
];

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
      plugins: { "your-move-engine": { rules: { "no-built-in-values": noBuiltInValues } } },
      rules: {
        "your-move-engine/no-built-in-values": "error",
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
          ...RESTRICTED_MEMBERS.map(({ object, property }) => ({
            object,
            property,
            message: `${object}.${property} reaches built-ins' internals indirectly; engines don't need it.`,
          })),
        ],
        "no-restricted-syntax": [
          "error",
          {
            selector: "NewExpression[callee.name='Date'][arguments.length=0]",
            message: "new Date() reads the clock; engines get time only as an argument.",
          },
          {
            selector: "NewExpression[callee.name='Date'] > SpreadElement",
            message: "new Date(...) with a spread can read the clock; pass the time explicitly.",
          },
          {
            selector: "ImportExpression",
            message: "Engines are synchronous and import only statically.",
          },
          {
            selector: "MetaProperty[meta.name='import']",
            message: "import.meta is host-provided; engines don't use it.",
          },
          // `.constructor` and `__proto__` by name, by any static key (string or template literal)
          // and by destructuring; a key computed at run time is beyond a static rule (F-5).
          ...[
            "MemberExpression[property.name=/^(constructor|__proto__)$/]",
            `MemberExpression[property.value=${PROTO_KEYS}]`,
            `MemberExpression[computed=true]${staticTemplateKey("property")}`,
            `ObjectPattern > Property[computed=false][key.name=${PROTO_KEYS}]`,
            `ObjectPattern > Property[key.value=${PROTO_KEYS}]`,
            `ObjectPattern > Property[computed=true]${staticTemplateKey("key")}`,
          ].map((selector) => ({
            selector,
            message: "Engines don't reach constructors or prototypes through values.",
          })),
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

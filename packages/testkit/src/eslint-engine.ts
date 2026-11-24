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

/** The built-in error classes, which an engine may extend (`class InvalidMove extends Error`). */
const ERROR_CLASSES: ReadonlySet<string> = new Set(
  ENGINE_GLOBALS.filter((name) => name.endsWith("Error")),
);

/** Pure conversion functions an engine may pass as an array method's callback. */
const CONVERSIONS: ReadonlySet<string> = new Set(["Boolean", "Number", "String"]);

/** The array methods whose first argument is a callback applied to each element. */
const CALLBACK_METHODS: ReadonlySet<string> = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "map",
  "some",
]);

type ParentNode = Partial<{
  type: string;
  object: unknown;
  callee: Partial<{ type: string; computed: boolean; property: Partial<{ name: string }> }>;
  arguments: unknown[];
  operator: string;
  right: unknown;
  superClass: unknown;
}>;

/**
 * Whether `identifier` is used by name: to reach a member, to call or construct the built-in, as
 * the right-hand side of `instanceof` (which only reads it), or an error class as a class heritage
 * (which makes a subclass: writes through it land on the subclass). None binds the built-in to a
 * name. The one value use allowed is a conversion function as an array method's callback
 * (`arr.map(Number)`): an array method only calls it. A static rule can't tell a user-defined
 * method of the same name from it (F-5), and writes by name to these three stay rejected.
 */
function namedUse(identifier: Rule.Node, name: string): boolean {
  const parent = identifier.parent as ParentNode;
  switch (parent.type) {
    // TypeScript's `typeof Math` and `typeof Math.random` in a type position are erased at compile
    // time (`Math as T` is not: it is still the value).
    case "TSTypeQuery":
    case "TSQualifiedName":
      return true;
    case "MemberExpression":
      return parent.object === identifier;
    case "CallExpression":
      return (
        parent.callee === identifier ||
        (CONVERSIONS.has(name) &&
          parent.arguments?.[0] === identifier &&
          parent.callee?.type === "MemberExpression" &&
          parent.callee.computed === false &&
          CALLBACK_METHODS.has(parent.callee.property?.name ?? ""))
      );
    case "NewExpression":
      return parent.callee === identifier;
    case "BinaryExpression":
      return parent.operator === "instanceof" && parent.right === identifier;
    case "ClassDeclaration":
    case "ClassExpression":
      return ERROR_CLASSES.has(name) && parent.superClass === identifier;
    default:
      return false;
  }
}

/**
 * Built-in objects and functions are used by name only: as `Math.max(…)`, `Number(…)`,
 * `new Map()`, `x instanceof Map` or `class E extends Error`, never as values (`const M = Math`,
 * `f(Math)`, `{ ...Math }`, `const { random } = Math`), except `Number`, `String` and `Boolean` as
 * an array method's callback (`arr.map(Number)`, `arr.filter(Boolean)`). The member and call rules
 * below can only see uses by name.
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
        if (!namedUse(identifier, variable.name)) {
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

/** `Object` and `Reflect` functions that change the object they are given. */
const MUTATORS: Readonly<Record<string, ReadonlySet<string>>> = {
  Object: new Set([
    "assign",
    "defineProperty",
    "defineProperties",
    "setPrototypeOf",
    "freeze",
    "seal",
    "preventExtensions",
  ]),
  Reflect: new Set([
    "defineProperty",
    "deleteProperty",
    "set",
    "setPrototypeOf",
    "preventExtensions",
  ]),
};

/**
 * Members of built-ins that are primitives: constants (`Math.PI`, `Number.MAX_SAFE_INTEGER`),
 * well-known symbols (`Symbol.iterator`) and `length`. Taking one as a value exposes nothing.
 */
function primitiveMember(root: string, property: string | undefined): boolean {
  return root === "Symbol" || property === "length" || /^[A-Z][A-Z0-9_]*$/u.test(property ?? "");
}

type ChainNode = Partial<{
  type: string;
  object: unknown;
  property: Partial<{ type: string; name: string }>;
  computed: boolean;
  parent: ChainNode;
  left: unknown;
  value: unknown;
  callee: unknown;
  tag: unknown;
  operator: string;
  argument: unknown;
  arguments: ChainNode[];
  expression: unknown;
}>;

/** The identifier a member chain (`a.b.c`) starts from, if it starts from one. */
function chainRoot(node: ChainNode | undefined): string | undefined {
  let current = node;
  while (current?.type === "MemberExpression") current = current.object as ChainNode;
  if (current?.type === "ChainExpression") return chainRoot(current.expression as ChainNode);
  return current?.type === "Identifier" ? (current as { name?: string }).name : undefined;
}

/** Whether `node` is a place a value is written to (assigned, updated, deleted or destructured into). */
function isWriteTarget(node: ChainNode): boolean {
  const parent = node.parent ?? {};
  switch (parent.type) {
    case "AssignmentExpression":
    case "AssignmentPattern":
      return parent.left === node;
    case "ForInStatement":
    case "ForOfStatement":
      return parent.left === node;
    case "UpdateExpression":
      return true;
    case "UnaryExpression":
      return parent.operator === "delete";
    case "ArrayPattern":
    case "RestElement":
      return true;
    case "Property":
      return parent.parent?.type === "ObjectPattern" && parent.value === node;
    default:
      return false;
  }
}

/**
 * Members of built-ins (02 §7.5): a member chain rooted at a built-in (`JSON.parse`,
 * `Array.prototype.push`) is never written to, assigned, deleted, or handed to a function that
 * changes its argument (`Object.freeze(Array.prototype)`), however deep the chain; and it is taken
 * as a value only if it is a primitive constant. Otherwise it is called (`Math.max(1)`), constructed,
 * or the object of a further member (`Array.prototype.slice.call(x)`), so a built-in's prototype or
 * method never reaches a name a write could go through.
 */
const noBuiltInMemberWrites: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Never write to built-ins' members, and use them by name only." },
    schema: [],
    messages: {
      write: "Engines must not write to built-in objects.",
      value: "Use {{name}}'s members by name (call them or reach a further member), not as values.",
    },
  },
  create(context) {
    const check = (variable: Scope.Variable) => {
      if (!ENGINE_GLOBALS.includes(variable.name) || PRIMITIVE_GLOBALS.has(variable.name)) return;
      for (const reference of variable.references) {
        const identifier = reference.identifier as ChainNode;
        let top = identifier;
        while (top.parent?.type === "MemberExpression" && top.parent.object === top)
          top = top.parent;
        if (top.parent?.type === "ChainExpression") top = top.parent;
        if (top === identifier) continue; // the identifier itself: no-built-in-values judges it
        const parent = top.parent ?? {};
        const last = (top.type === "ChainExpression" ? (top.expression as ChainNode) : top).property
          ?.name;
        if (isWriteTarget(top)) {
          context.report({ node: top as Rule.Node, messageId: "write" });
        } else if (parent.type === "CallExpression" && parent.callee === top) {
          const mutator = MUTATORS[variable.name]?.has(last ?? "") === true;
          const target = parent.arguments?.[0];
          const root =
            target?.type === "Identifier" ? (target as { name?: string }).name : chainRoot(target);
          if (mutator && root !== undefined && ENGINE_GLOBALS.includes(root)) {
            context.report({ node: parent as Rule.Node, messageId: "write" });
          }
        } else if (
          !(parent.type === "NewExpression" && parent.callee === top) &&
          !(parent.type === "TaggedTemplateExpression" && parent.tag === top) &&
          !(parent.type === "UnaryExpression" && parent.operator === "typeof") &&
          !primitiveMember(variable.name, last)
        ) {
          context.report({
            node: top as Rule.Node,
            messageId: "value",
            data: { name: variable.name },
          });
        }
      }
    };
    return {
      "Program:exit"(node) {
        context.sourceCode
          .getScope(node)
          .variables.filter((variable) => variable.defs.length === 0)
          .forEach(check);
      },
    };
  },
};

/**
 * Keys that lead from a value to its constructor or prototype: `constructor`, `__proto__`, and the
 * legacy accessor methods every object inherits (`({}).__lookupGetter__("__proto__")` is the
 * prototype getter; `__defineGetter__` and `__defineSetter__` write accessors onto any object).
 */
const PROTO_KEYS =
  "/^(constructor|__proto__|__lookupGetter__|__lookupSetter__|__defineGetter__|__defineSetter__)$/";

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
    "getPrototypeOf",
    "set",
    "setPrototypeOf",
  ].map((property) => ({ object: "Reflect", property })),
  // `Object.getPrototypeOf([])` is `Array.prototype`, a write target a by-name rule can't see.
  ...["getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getPrototypeOf"].map(
    (property) => ({
      object: "Object",
      property,
    }),
  ),
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
      plugins: {
        "your-move-engine": {
          rules: {
            "no-built-in-values": noBuiltInValues,
            "no-built-in-member-writes": noBuiltInMemberWrites,
          },
        },
      },
      rules: {
        "your-move-engine/no-built-in-values": "error",
        "your-move-engine/no-built-in-member-writes": "error",
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
          // `.constructor`, `__proto__` and the legacy accessor methods by name, by any static key (string or template literal)
          // and by destructuring; a key computed at run time is beyond a static rule (F-5).
          ...[
            `MemberExpression[property.name=${PROTO_KEYS}]`,
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
          // Writes to built-ins' members, however deep, are the no-built-in-member-writes rule's.
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

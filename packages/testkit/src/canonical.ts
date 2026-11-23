/**
 * Comparing module output: views, records, states and errors are compared as canonical JSON
 * (object keys sorted), because the framework stores and serves them as JSON.
 */

const sortKeys = (_key: string, value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
};

/** JSON with object keys in a stable order; `undefined` stays distinguishable from absent. */
export function canonical(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value, sortKeys);
}

/** Whether two module outputs are the same once serialised. */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Whether `value` is plain JSON data that survives a JSON round trip unchanged: no `undefined`,
 * non-finite numbers, class instances, `Map`s, `Date`s or functions.
 */
export function isPlainJson(value: unknown): boolean {
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (value === null) return true;
      if (Array.isArray(value)) return value.every(isPlainJson);
      const proto: unknown = Object.getPrototypeOf(value);
      return (
        (proto === Object.prototype || proto === null) && Object.values(value).every(isPlainJson)
      );
    }
    default:
      return false;
  }
}

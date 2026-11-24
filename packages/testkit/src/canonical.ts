/**
 * Comparing module output: views, records, states and errors are compared as the JSON the
 * framework stores and serves. Key order is kept, not normalised: it reaches clients on the wire,
 * so a key order that follows hidden state is a leak (02 §6.3).
 */

/** The JSON text of `value`, keys in insertion order; `undefined` stays distinguishable. */
export function canonical(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
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

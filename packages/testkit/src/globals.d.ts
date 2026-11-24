/**
 * The one host API the kit uses beyond ECMAScript: a monotonic clock for the CPU budget check
 * (02 §6.6). Node, browsers and Workers all provide it; the kit's tsconfig loads no host types.
 */
declare const performance: { now(): number };

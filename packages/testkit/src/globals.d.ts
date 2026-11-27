/**
 * The host APIs the kit uses beyond ECMAScript, which Node, browsers and Workers all provide; the
 * kit's tsconfig loads no host types:
 * - a monotonic clock for the CPU budget check (02 §6.6);
 * - `structuredClone`, so a module under test gets its own copy of options to resolve (02 §2.1
 *   rule 10, A15-P-5).
 */
declare const performance: { now(): number };
declare function structuredClone<T>(value: T): T;

/**
 * How the kit records failures and calls into a module: every exception from module code is a
 * failure (errors are values, 02 §2.1 rule 3), and a game stops at its first failure.
 */
import { isGameError, type AnyGameDefinition, type Seat } from "@your-move/sdk";

import { sameJson } from "./canonical.js";
import type { KitFailure, KitProperty } from "./types.js";

/** At most this many failures are kept per property; the rest add nothing. */
const MAX_FAILURES_PER_PROPERTY = 5;

/** Ends the current game after its first failure. */
export class GameAborted extends Error {}

/** One rules version, one resolved option set and one seat count: what a game is played with. */
export interface Combo {
  readonly def: AnyGameDefinition;
  readonly options: unknown;
  readonly seats: number;
}

/** Where a failure happened. */
export type Where = Partial<Pick<KitFailure, "version" | "seats" | "seed">>;

/** An exception as text: class and message. */
export function errorName(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** States are JSON (02 §5), so a JSON copy is a full copy. */
export const jsonClone = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

/** Every viewer of a game: each seat, then the public (`null`). */
export const viewers = (seats: number): (Seat | null)[] => [
  ...Array.from({ length: seats }, (_, seat) => seat),
  null,
];

/** Collects failures, at most a few per property. */
export class Reporter {
  readonly failures: KitFailure[] = [];
  private readonly counts = new Map<KitProperty, number>();

  fail(property: KitProperty, message: string, where: Where = {}): void {
    const count = this.counts.get(property) ?? 0;
    this.counts.set(property, count + 1);
    if (count < MAX_FAILURES_PER_PROPERTY) this.failures.push({ property, message, ...where });
  }

  /** Calls into the module; an exception is a failure of `property` (exceptions are bugs, 02 §2.1). */
  call<T>(property: KitProperty, what: string, where: Where, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      this.fail(property, `${what} threw ${errorName(error)}`, where);
      throw new GameAborted();
    }
  }

  check(ok: boolean, property: KitProperty, message: string, where: Where): void {
    if (!ok) {
      this.fail(property, message, where);
      throw new GameAborted();
    }
  }

  /** Fails unless `def` declares `code` (02 §2.1 rule 3). */
  errorCode(def: AnyGameDefinition, code: string, what: string, where: Where): void {
    if (!def.errorCodes.includes(code)) {
      this.fail("schema", `${what} returned code ${code}, which isn't in errorCodes`, where);
    }
  }

  /** Fails unless `value` is OK or a declared GameError. */
  okOrGameError(def: AnyGameDefinition, value: unknown, what: string, where: Where): void {
    if (isGameError(value)) this.errorCode(def, value.code, what, where);
    else if (!sameJson(value, { ok: true })) {
      this.fail("schema", `${what} must return OK or a GameError`, where);
    }
  }

  /** Runs `fn`, then forgets every failure it recorded: used to collect observations only. */
  quietly(fn: () => void): void {
    const saved = [...this.failures];
    const savedCounts = new Map(this.counts);
    try {
      fn();
    } finally {
      this.failures.splice(0, this.failures.length, ...saved);
      this.counts.clear();
      for (const [key, value] of savedCounts) this.counts.set(key, value);
    }
  }
}

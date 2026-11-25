/**
 * Module calls behind a fault boundary (09 §5, A2 review S-5). An exception from a game module's
 * code may quote what it was working on — a hand, the bag, a raw action — so it never reaches the
 * log as it is: every function of a definition the registry hands out rethrows as an
 * {@link EngineFault}, which the app logs by the game type, the member called, the original's
 * class and its stack frames, never its message.
 */
import type { AnyGameDefinition } from "@your-move/sdk";

/** A game module's code threw. Its message is fixed; the original is the `cause`. */
export class EngineFault extends Error {
  override readonly name = "EngineFault";
  readonly gameType: string;
  readonly member: string;

  constructor(gameType: string, member: string, cause: unknown) {
    super("a game module call threw", { cause });
    this.gameType = gameType;
    this.member = member;
  }
}

/**
 * The definition with every function member wrapped: a throw becomes an {@link EngineFault}.
 * Everything else (schemas, version, error codes) is the module's own.
 */
export function guardEngine(definition: AnyGameDefinition): AnyGameDefinition {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(definition, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      let guarded = wrapped.get(key);
      if (guarded === undefined) {
        const member = String(key);
        guarded = (...args: unknown[]): unknown => {
          try {
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (error) {
            throw new EngineFault(target.type, member, error);
          }
        };
        wrapped.set(key, guarded);
      }
      return guarded;
    },
  });
}

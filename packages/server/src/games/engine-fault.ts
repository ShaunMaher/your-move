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
 * A schema member (`actionSchema`, `optionsSchema`, `configSchema`) has its `parse` and
 * `safeParse` wrapped the same way, as a refinement of a module's schema is module code too.
 * Everything else (version, error codes) is the module's own.
 */
const PARSERS = new Set<PropertyKey>(["parse", "safeParse", "parseAsync", "safeParseAsync"]);

function isSchema(value: unknown): value is object {
  return typeof value === "object" && value !== null && "safeParse" in value;
}

/** The call, with a throw turned into an {@link EngineFault} for `member`. */
function guarded(gameType: string, member: string, call: () => unknown): unknown {
  try {
    return call();
  } catch (error) {
    throw new EngineFault(gameType, member, error);
  }
}

/** A schema whose parse methods are behind the boundary; the rest is the schema's own. */
function guardSchema(gameType: string, member: string, schema: object): object {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(schema, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function" || !PARSERS.has(key)) return value;
      let method = wrapped.get(key);
      if (method === undefined) {
        method = (...args: unknown[]): unknown =>
          guarded(gameType, `${member}.${String(key)}`, () =>
            (value as (...a: unknown[]) => unknown).apply(target, args),
          );
        wrapped.set(key, method);
      }
      return method;
    },
  });
}

export function guardEngine(definition: AnyGameDefinition): AnyGameDefinition {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(definition, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (isSchema(value)) {
        let schema = wrapped.get(key);
        if (schema === undefined) {
          schema = guardSchema(target.type, String(key), value);
          wrapped.set(key, schema);
        }
        return schema;
      }
      if (typeof value !== "function") return value;
      let method = wrapped.get(key);
      if (method === undefined) {
        method = (...args: unknown[]): unknown =>
          guarded(target.type, String(key), () =>
            (value as (...a: unknown[]) => unknown).apply(target, args),
          );
        wrapped.set(key, method);
      }
      return method;
    },
  });
}

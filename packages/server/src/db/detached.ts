/**
 * Repositories with no database behind them, for an app that never touches storage: the OpenAPI
 * document generator (`pnpm api:generate`) and tests of HTTP behaviour alone. Every call rejects,
 * so accidental use fails loudly instead of pretending to succeed.
 */
import type { GameRepo, Repositories, UserRepo } from "./repositories.js";

export class DetachedStorageError extends Error {
  override readonly name = "DetachedStorageError";

  constructor(operation: string) {
    super(`${operation}: this app has no database`);
  }
}

/**
 * Every method of each repository. `satisfies` makes the compiler demand an entry for each one,
 * so a method added to an interface can't be left undefined here.
 */
const METHODS = {
  users: { create: true, findById: true, findByEmail: true } satisfies Record<keyof UserRepo, true>,
  games: {
    create: true,
    get: true,
    players: true,
    actions: true,
    applyTransition: true,
    liveGames: true,
  } satisfies Record<keyof GameRepo, true>,
} as const satisfies Record<keyof Repositories, object>;

function detached<K extends string>(
  name: string,
  methods: Record<K, true>,
): Record<K, () => Promise<never>> {
  return Object.fromEntries(
    Object.keys(methods).map((method) => [
      method,
      () => Promise.reject(new DetachedStorageError(`${name}.${method}`)),
    ]),
  ) as Record<K, () => Promise<never>>;
}

export function detachedRepositories(): Repositories {
  return {
    users: detached("users", METHODS.users),
    games: detached("games", METHODS.games),
  };
}

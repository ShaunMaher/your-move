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

function detached<T extends object>(name: string, methods: readonly (keyof T & string)[]): T {
  return Object.fromEntries(
    methods.map((method) => [
      method,
      () => Promise.reject(new DetachedStorageError(`${name}.${method}`)),
    ]),
  ) as T;
}

export function detachedRepositories(): Repositories {
  return {
    users: detached<UserRepo>("users", ["create", "findById", "findByEmail"]),
    games: detached<GameRepo>("games", [
      "create",
      "get",
      "players",
      "actions",
      "applyTransition",
      "liveGames",
    ]),
  };
}

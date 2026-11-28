/**
 * Game client modules, lazily imported through the generated client import map (02 §7.3): a
 * game's client chunk is fetched the first time a game of that type is opened or created.
 */
import type { GameClientModule } from "@your-move/sdk/client";

import { gameClients } from "../../../generated/client-games.js";

const isComponent = (value: unknown): boolean =>
  typeof value === "function" || (typeof value === "object" && value !== null);

/** Whether an imported entry point is a `GameClientModule` (02 §3) for the type asked for. */
function isClientModule(value: unknown, type: string): value is GameClientModule {
  if (typeof value !== "object" || value === null) return false;
  const found: Readonly<Record<string, unknown>> = value as Readonly<Record<string, unknown>>;
  return (
    found["type"] === type &&
    Array.isArray(found["versions"]) &&
    ["OptionsForm", "Board", "RulesSheet", "HistoryItem"].every((key) => isComponent(found[key]))
  );
}

const loading = new Map<string, Promise<GameClientModule | null>>();

/**
 * The client module of an installed game type, or `null` if the type isn't installed or its chunk
 * can't be loaded or isn't a client module. A failed load is forgotten, so the next ask retries.
 */
export function loadGameClient(type: string): Promise<GameClientModule | null> {
  const known = loading.get(type);
  if (known !== undefined) return known;
  const load = Object.hasOwn(gameClients, type) ? gameClients[type] : undefined;
  if (load === undefined) return Promise.resolve(null);
  const attempt = load()
    .then((entry) => {
      const client: unknown =
        typeof entry === "object" && entry !== null && "client" in entry ? entry.client : undefined;
      return isClientModule(client, type) ? client : null;
    })
    .catch(() => null)
    .then((client) => {
      if (client === null) loading.delete(type);
      return client;
    });
  loading.set(type, attempt);
  return attempt;
}

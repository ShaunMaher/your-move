/**
 * Game client modules, lazily imported through the generated client import map (02 §7.3). The
 * game shell (M3) loads a game's client only when one of its games is opened.
 */
import { gameClients } from "../../../generated/client-games.js";

/** Loads the client module of an installed game type, or `null` if the type isn't installed. */
export async function loadGameClient(type: string): Promise<unknown> {
  const load = Object.hasOwn(gameClients, type) ? gameClients[type] : undefined;
  return load ? load() : null;
}

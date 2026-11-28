/**
 * The instance's games as the core sees them (02 §7.3): the resource provider over the enabled
 * dictionaries and the registry of the installed game packages, built the same way for the HTTP
 * app and for the sweep. Throws `GameConfigError` or `ResourceConfigError` for a configuration
 * the games or their resources refuse.
 */
import type { Platform } from "../platform.js";
import { createGameRegistry, type GameRegistry, type InstalledGame } from "./registry.js";
import { createResourceProvider, type ResourceProvider } from "./resources.js";

export interface InstanceGames {
  readonly registry: GameRegistry;
  readonly resources: ResourceProvider;
}

export function instanceGames(platform: Platform, games: readonly InstalledGame[]): InstanceGames {
  const { config } = platform;
  const resources = createResourceProvider({
    dictionaries: platform.dictionaries,
    enabled: config.dictionariesEnabled,
    now: () => platform.now().getTime(),
  });
  const registry = createGameRegistry(games, {
    gameConfig: config.gameConfig,
    enabledGames: config.enabledGames,
    resources: resources.enabled(),
  });
  return { registry, resources };
}

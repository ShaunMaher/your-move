import type { GameManifest } from "@your-move/sdk";

/**
 * The paths game's manifest (docs/spec/02-game-framework.md §7.2, docs/spec/games/paths.md).
 * Placeholder until M5: the icon and the rules text arrive with the engine.
 */
export const manifest: GameManifest = {
  type: "paths",
  name: "Paths",
  description: "Lay tiles to extend your path and stay on the board.",
  icon: "",
  licence: "BSD-2-Clause",
  resources: [],
  hiddenInformation: true,
  players: { min: 2, max: 8 },
  rules: {},
};

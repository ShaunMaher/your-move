import type { GameManifest } from "@your-move/sdk";

/**
 * The example game's manifest (docs/spec/02-game-framework.md §7.2, docs/spec/02-game-framework.md §7.6).
 * Placeholder until M1: the icon and the rules text arrive with the engine.
 */
export const manifest: GameManifest = {
  type: "example",
  name: "Example",
  description: "A tiny hidden-hand card game: the reference game for game authors.",
  icon: "",
  licence: "BSD-2-Clause",
  resources: [],
  hiddenInformation: true,
  players: { min: 2, max: 4 },
  rules: {},
};

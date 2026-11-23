import type { GameManifest } from "@your-move/sdk";

/**
 * The words game's manifest (docs/spec/02-game-framework.md §7.2, docs/spec/games/words.md).
 * Placeholder until M1: the icon and the rules text arrive with the engine.
 */
export const manifest: GameManifest = {
  type: "words",
  name: "Words",
  description: "Build crossing words from your tiles on a shared board.",
  icon: "",
  licence: "BSD-2-Clause",
  resources: ["dictionary"],
  hiddenInformation: true,
  players: { min: 2, max: 2 },
  rules: {},
};

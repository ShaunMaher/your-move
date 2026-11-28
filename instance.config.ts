/**
 * The game packages this instance installs (docs/spec/02-game-framework.md §7.3). An operator's
 * fork or deployment repository edits this list, adds each package to the root package.json, and
 * runs `pnpm build` (which runs `pnpm games:generate` and `pnpm games:verify`).
 *
 * `words` (the word game, M1b) is installed and enabled; `example` (the reference game, 02 §7.6)
 * is installed but disabled for new games; `paths` (the path-laying game, M5) and `pairs` (the
 * memory game, A25–A26) are installed and enabled.
 */
import { defineInstance } from "@your-move/scripts/instance";

export default defineInstance({
  games: [
    { package: "@your-move/game-words" },
    { package: "@your-move/game-paths" },
    { package: "@your-move/game-pairs" },
    { package: "@your-move/game-example", enabled: false },
    // { package: "@someone/game-hex", acceptLicence: "MPL-2.0" },  // a third-party game
  ],
});

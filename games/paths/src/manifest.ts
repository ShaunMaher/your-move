import type { GameManifest } from "@your-move/sdk";

/**
 * Original artwork: one square tile with two curved paths crossing it and a marker at the end of
 * one of them. Basic shapes only (02 §7.2).
 */
const ICON = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
  '<rect x="2" y="2" width="60" height="60" rx="8" fill="#24496b"/>',
  '<rect x="10" y="10" width="44" height="44" rx="4" fill="#f4ecd8"/>',
  '<path d="M24 10 C24 30 40 34 54 40" fill="none" stroke="#2f8f6b" stroke-width="5"/>',
  '<path d="M10 40 C30 40 40 24 40 10" fill="none" stroke="#d98a2b" stroke-width="5"/>',
  '<circle cx="24" cy="10" r="5" fill="#c0392b"/>',
  "</svg>",
].join("");

/** The rules of version 1, in our own words, as Markdown without HTML (02 §7.2, paths §1–§5). */
const RULES_V1 = `# Paths

A tile-laying game for 2 to 8 players. Everyone builds the paths together, and each player guides a marker along them. Keep your marker on the board: the last marker left wins.

## The board and the tiles

- The board has 6 rows of 6 squares. Each edge of a square has two notches, so a square has 8.
- Each tile joins its 8 notches in pairs with 4 paths. There are 35 different tiles, one of each, and the deck holds all of them, shuffled. Nobody sees the deck.
- You hold a hand of tiles (3 unless the game's creator chose fewer). Nobody else sees your tiles.

## Placing your marker

In turn order, each player puts their marker on a free notch on the edge of the board. When everyone has placed, everyone is dealt a full hand and the first player starts.

## Your turn

1. Choose a tile from your hand and turn it any way you like. It always goes on the square your marker faces.
2. Every marker facing that square follows the path it now stands on, across the new tile and on across any tiles it leads into, until it faces an empty square again. Other players' markers can move too.
3. A marker that is led off the edge of the board is out. Two markers that meet head on along the same path both end up off the board, so both are out.
4. If any tile and turn in your hand keeps your own marker on the board, you must play one of those. Only when every choice would take you off the board must you play one anyway. (The game's creator can switch this rule off.) So when this rule is on and you run yourself off the board, everyone can tell that every tile in your hand would have done the same.
5. If you're still in, draw a tile.

Players who are out put their tiles back: they're shuffled into the deck and dealt straight out to the players who are short of tiles.

## Running out of tiles

- When the deck is empty, you draw nothing. The first player who misses a draw takes the draw-first token.
- When tiles come back to the deck, they're dealt one at a time, in turn order, starting with the token holder, to every player short of a full hand. If the deck runs dry again, the token goes to the next player still short; otherwise it's put away.
- A player with no tiles is skipped until they get some.

## The end

- The last player with a marker on the board wins. The others rank by when they went out: the later, the better, and players out in the same turn tie.
- If the last markers all go out on the same turn, those players share the win.
- If nobody left holds a tile, everyone still on the board shares the win.
- If you resign or run out of time, your marker leaves the board and your tiles go back to the deck. Leaving before you place your marker counts as declining the game, not losing it.
`;

/**
 * The paths game's manifest (docs/spec/02-game-framework.md §7.2, docs/spec/games/paths.md). A
 * plain data module: it imports nothing at runtime.
 */
export const manifest: GameManifest = {
  type: "paths",
  name: "Paths",
  description: "Lay tiles to extend your path and stay on the board.",
  icon: ICON,
  licence: "BSD-2-Clause",
  resources: [],
  hiddenInformation: true,
  players: { min: 2, max: 8 },
  rules: { 1: RULES_V1 },
};

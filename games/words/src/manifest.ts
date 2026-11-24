import type { GameManifest } from "@your-move/sdk";

/**
 * Original artwork: five plain tiles crossing on a board square, one of them marked. Basic shapes
 * only (02 §7.2).
 */
const ICON = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
  '<rect x="2" y="2" width="60" height="60" rx="8" fill="#2f6b4f"/>',
  '<rect x="8" y="23" width="15" height="15" rx="3" fill="#f2e6c9"/>',
  '<rect x="25" y="23" width="15" height="15" rx="3" fill="#f2e6c9"/>',
  '<rect x="42" y="23" width="15" height="15" rx="3" fill="#f2e6c9"/>',
  '<rect x="25" y="6" width="15" height="15" rx="3" fill="#f2e6c9"/>',
  '<rect x="25" y="40" width="15" height="15" rx="3" fill="#f2e6c9"/>',
  '<circle cx="32.5" cy="30.5" r="3.5" fill="#c0392b"/>',
  "</svg>",
].join("");

/** The rules of version 1, in our own words, as Markdown without HTML (02 §7.2). */
const RULES_V1 = `# Words

A crossword game for two players: build words from your tiles on a shared board, crossing the words already there.

## The game

- The game's creator picks a ruleset and a word list. The ruleset sets the board, the tiles and their points, the rack size and the bonuses; the word list decides which words count.
- Each player draws a rack of tiles from a shuffled bag; the ruleset sets how many. Nobody sees the bag or the other player's rack.
- A blank tile is worth nothing but can stand for any letter. You choose the letter when you play it, and it keeps that letter for the rest of the game.

## Your turn

On your turn you do one of these:

- **Play tiles.** Put one or more tiles from your rack on empty squares, all in one row or all in one column, so that together with the tiles already there they make one unbroken line.
  - The first play of the game uses at least two tiles and covers the start square.
  - Every later play touches at least one tile already on the board, side by side or above and below.
  - Every word your tiles make, along the line and across it, must be in the game's word list. A play that makes a word that isn't is refused and you try again.
- **Swap tiles.** Put one or more tiles back and draw the same number, while the bag still holds as many tiles as the ruleset requires. Depending on the ruleset you either draw before putting yours back, so you can't draw your own tiles again, or put yours back first and may draw some of them again.
- **Pass.**

After a play you draw back up to a full rack, or as many tiles as the bag has left.

## Scoring

- Each word you make scores the points of its letters. A blank scores nothing.
- A letter on a double or triple letter square counts two or three times.
- A word over a double or triple word square counts two or three times. Two of them in one word multiply together: two doubles make four times, a double and a triple make six times.
- Premium squares count only on the turn a tile is first played on them.
- Playing all the tiles of a full rack in one play earns a bonus set by the ruleset.

## The end

The game ends when:

- the bag is empty and a player plays their last tile: they gain the points left on the other player's rack, and the other player loses them;
- a number of turns in a row, set by the ruleset, score nothing (passes, swaps and plays worth nothing all count): each player loses the points left on their own rack;
- a player resigns or runs out of time: they lose, whatever the scores.

Otherwise the higher score wins, and equal scores are a draw. When the game is over everyone's last rack is shown, but never the order of the bag.
`;

/**
 * The words game's manifest (docs/spec/02-game-framework.md §7.2, docs/spec/games/words.md). A
 * plain data module: it imports nothing at runtime.
 */
export const manifest: GameManifest = {
  type: "words",
  name: "Words",
  description: "Build crossing words from your tiles on a shared board.",
  icon: ICON,
  licence: "BSD-2-Clause",
  resources: ["dictionary"],
  hiddenInformation: true,
  players: { min: 2, max: 2 },
  rules: { 1: RULES_V1 },
};

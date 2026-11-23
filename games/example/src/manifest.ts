import type { GameManifest } from "@your-move/sdk";

/** Original artwork: two plain cards, the front one marked. Basic shapes only (02 §7.2). */
const ICON = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
  '<rect x="8" y="12" width="28" height="40" rx="4" fill="#3b6ea5"/>',
  '<rect x="26" y="8" width="28" height="40" rx="4" fill="#f4f1e8" stroke="#3b6ea5" stroke-width="3"/>',
  '<circle cx="40" cy="28" r="7" fill="#d1495b"/>',
  "</svg>",
].join("");

/** The rules of version 1, as Markdown without HTML (02 §7.2). */
const RULES_V1 = `# Example

A small card game for 2 to 4 players: play your cards in secret, then reveal them together.

## Setup

- The deck has one each of the cards 1 to 20, shuffled.
- Every player is dealt a hand (3 cards unless the game's options say otherwise) and starts with 2 lives (or as many as the options say).

## Rounds

- Every round, each player still in the game picks one card from their hand and plays it face down. Players pick in any order, and nobody sees a card until everyone has played.
- Then all the cards are revealed. The highest card scores a point and the lowest card loses a life.
- A player with no lives left is out.
- If the deck still has a card for every player still in, each of them draws one.

## The end

- The game ends when only one player is left, or when the players run out of cards.
- Players still in rank above players who are out: more lives first, then more points. Players who are equal on both share a rank.
- Players who are out rank by how long they lasted.
- Resigning or running out of time puts you out of the game.
`;

/**
 * The example game's manifest (docs/spec/02-game-framework.md §7.2, §7.6). A plain data module:
 * it imports nothing at runtime.
 */
export const manifest: GameManifest = {
  type: "example",
  name: "Example",
  description: "A tiny hidden-hand card game: the reference game for game authors.",
  icon: ICON,
  licence: "BSD-2-Clause",
  resources: [],
  hiddenInformation: true,
  players: { min: 2, max: 4 },
  rules: { 1: RULES_V1 },
};

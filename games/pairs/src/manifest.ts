import type { GameManifest } from "@your-move/sdk";

/**
 * Original artwork: two cards side by side, the left one face down with a dotted back, the right
 * one face up showing a simple star. Basic shapes only (02 §7.2, pairs §8.8).
 */
const ICON = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
  '<rect x="4" y="12" width="26" height="40" rx="4" fill="#3a5a8c"/>',
  '<circle cx="12" cy="22" r="2.5" fill="#d7e3f4"/>',
  '<circle cx="22" cy="22" r="2.5" fill="#d7e3f4"/>',
  '<circle cx="17" cy="32" r="2.5" fill="#d7e3f4"/>',
  '<circle cx="12" cy="42" r="2.5" fill="#d7e3f4"/>',
  '<circle cx="22" cy="42" r="2.5" fill="#d7e3f4"/>',
  '<rect x="34" y="12" width="26" height="40" rx="4" fill="#fbf6ea" stroke="#3a5a8c" stroke-width="2"/>',
  '<path d="M47 22 L49.6 29.2 L57 29.4 L51.2 34 L53.3 41.2 L47 37 L40.7 41.2 L42.8 34 L37 29.4 L44.4 29.2 Z" fill="#e0a526"/>',
  "</svg>",
].join("");

/** The rules of version 1, in our own words, as Markdown without HTML (02 §7.2, pairs §3–§6, §8.8). */
const RULES_V1 = `# Pairs

A card game for 2 to 6 players about remembering where things are. The cards lie face down in a grid, and every picture is on exactly two cards. Turn over two cards at a time and find the matching pairs. Whoever finds the most pairs wins.

## The cards

- The game's creator chooses the grid: 4 × 4 (8 pairs), 4 × 5 (10 pairs), 5 × 6 (15 pairs) or 6 × 6 (18 pairs).
- Everyone can see which pictures are in the game, but not where they lie.

## Your turn

1. Turn over any card that isn't already matched. Everyone sees it.
2. Then turn over a second card.
   - If the two cards match, the pair is yours: it stays face up, and you take another turn.
   - If they don't match, they stay face up for the next player to see, and the turn passes to the next player.
3. The two cards that didn't match stay face up only until the next player turns over their first card. Then they turn face down again, and nobody is shown them until someone turns them over again: you have to remember where they were.

With three or more players, only the next player is sure to see the cards that didn't match. The others see them only if they look before that player turns over a card.

## What the history shows

The history says who turned over a card and whether it was their first or second, but never which card it was or what was on it.

## Leaving the game

If you resign or run out of time, you're out, but the pairs you found stay yours. If you leave in the middle of your turn, your first card turns back face down. Leaving before you turn over your first card counts as declining the game, not losing it.

## The end

- When every pair is found, the player with the most pairs wins. Players with the same number of pairs share their place. Players who left rank below everyone still playing, the last to leave highest.
- If only one player is left, they win.
- The game also has a move limit, so it always ends: every card turned over, and every player leaving, counts as one move. The limit is 256 moves on 4 × 4, 400 on 4 × 5, 900 on 5 × 6 and 1,296 on 6 × 6. When a second card, or the player whose turn it is leaving, brings the count to the limit or past it, the game ends, and players rank by the pairs they found, as above. The game shows how many moves are left as the limit nears.

## Playing fair

The game only works if everyone remembers for themselves. Writing down where the pictures are, taking screenshots or using a tool that remembers for you spoils the game for everyone else, and they can't tell.
`;

/**
 * The pairs game's manifest (docs/spec/02-game-framework.md §7.2, docs/spec/games/pairs.md §8.8).
 * "Pairs" is a working name (Q32). A plain data module: it imports nothing at runtime.
 */
export const manifest: GameManifest = {
  type: "pairs",
  name: "Pairs",
  description: "Turn over two cards at a time and find the matching pairs.",
  icon: ICON,
  licence: "BSD-2-Clause",
  resources: [],
  hiddenInformation: true,
  players: { min: 2, max: 6 },
  rules: { 1: RULES_V1 },
};

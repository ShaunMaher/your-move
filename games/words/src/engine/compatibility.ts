/**
 * Ruleset ↔ dictionary compatibility (docs/spec/games/words.md §9.3): the languages match and
 * every letter the dictionary's words use has a tile in the ruleset. It works from the resource
 * metadata alone (the alphabet computed when the dictionary was built), never the word list, so
 * `resolveOptions`, `catalog` and `checkConfig` can use it (words §10.1).
 */
import type { ResourceMeta } from "@your-move/sdk";

import type { Ruleset } from "./rulesets/schema.js";

/** What compatibility needs to know about a dictionary. */
export type DictionaryTraits = Pick<ResourceMeta, "language" | "alphabet">;

/** The dictionary's letters that have no tile in the ruleset (a letter with count 0 has none). */
export function missingLetters(ruleset: Ruleset, dictionary: DictionaryTraits): string[] {
  return dictionary.alphabet.filter((letter) => {
    // Own keys only: an alphabet entry such as "constructor" must not find Object.prototype.
    const tile = Object.hasOwn(ruleset.tiles, letter) ? ruleset.tiles[letter] : undefined;
    return tile === undefined || tile.count === 0;
  });
}

/** Whether a game may use this ruleset with this dictionary (words §9.3). */
export function isCompatible(ruleset: Ruleset, dictionary: DictionaryTraits): boolean {
  return (
    ruleset.language === dictionary.language && missingLetters(ruleset, dictionary).length === 0
  );
}

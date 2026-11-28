/**
 * The 18 card faces (docs/spec/games/pairs.md §1). The ids and what each one depicts are part of
 * the rules version; the client draws them and uses these names in accessible names and status
 * text. The engine itself only compares ids.
 */

/** A face's name and its plural, by face id. */
export interface FaceName {
  readonly name: string;
  readonly plural: string;
}

/** The faces, indexed by id 0–17; frozen, entries included. */
export const FACES: readonly FaceName[] = Object.freeze(
  [
    { name: "acorn", plural: "acorns" },
    { name: "apple", plural: "apples" },
    { name: "bell", plural: "bells" },
    { name: "boat", plural: "boats" },
    { name: "cat", plural: "cats" },
    { name: "cloud", plural: "clouds" },
    { name: "fish", plural: "fish" },
    { name: "flower", plural: "flowers" },
    { name: "house", plural: "houses" },
    { name: "key", plural: "keys" },
    { name: "kite", plural: "kites" },
    { name: "leaf", plural: "leaves" },
    { name: "moon", plural: "moons" },
    { name: "snail", plural: "snails" },
    { name: "star", plural: "stars" },
    { name: "sun", plural: "suns" },
    { name: "tree", plural: "trees" },
    { name: "umbrella", plural: "umbrellas" },
  ].map((face) => Object.freeze(face)),
);

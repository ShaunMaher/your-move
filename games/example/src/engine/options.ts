/**
 * Creating a game: options, the catalog and the seat-count check (docs/spec/02-game-framework.md
 * §2, "Creating a game"). These run in the framework at create time and are never replayed.
 */
import { OK, type GameError, type Ok } from "@your-move/sdk";

import { DECK_SIZE, ERROR_CODES, HAND_SIZE, LIVES, type Catalog, type Options } from "./schemas.js";

/** The options a creator may set, with their ranges. */
const RANGES = { handSize: HAND_SIZE, lives: LIVES } as const;
type OptionName = keyof typeof RANGES;

function isOptionName(key: string): key is OptionName {
  return Object.hasOwn(RANGES, key);
}

/**
 * Resolves a creator's partial input to complete options: missing fields take their defaults,
 * anything else is an error value naming the offending option (02 §2.1 rule 3). `undefined` and
 * `null` mean "all defaults".
 */
export function resolveOptions(input: unknown): Options | GameError {
  const given = input ?? {};
  if (typeof given !== "object" || Array.isArray(given)) {
    return { code: ERROR_CODES.optionsNotObject };
  }
  const options: Options = { handSize: HAND_SIZE.default, lives: LIVES.default };
  for (const [key, value] of Object.entries(given)) {
    if (!isOptionName(key)) return { code: ERROR_CODES.unknownOption, detail: { option: key } };
    if (value === undefined) continue;
    const { min, max } = RANGES[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      return { code: ERROR_CODES.optionOutOfRange, detail: { option: key, min, max } };
    }
    options[key] = value;
  }
  return options;
}

/** The option ranges and defaults, for the new-game form (02 §2 `catalog`). */
export function catalog(): Catalog {
  return {
    deckSize: DECK_SIZE,
    handSize: { ...HAND_SIZE },
    lives: { ...LIVES },
  };
}

/** Refuses a seat count the deck can't deal a full hand to (02 §2 `validateStart`). */
export function validateStart(options: Options, seats: number): Ok | GameError {
  const needed = seats * options.handSize;
  return needed <= DECK_SIZE
    ? OK
    : { code: ERROR_CODES.deckTooSmall, detail: { needed, deckSize: DECK_SIZE } };
}

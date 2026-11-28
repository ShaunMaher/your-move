/**
 * Creating a game: options, the catalog and the seat-count check (docs/spec/games/paths.md §6,
 * docs/spec/02-game-framework.md §2 "Creating a game"). These run in the framework at create time
 * and are never replayed.
 */
import type { GameError } from "@your-move/sdk";

import {
  BOARD_SIZES,
  DEFAULT_BOARD_SIZE,
  DEFAULT_SELF_ELIMINATION,
  ERROR_CODES,
  HAND_SIZE,
  SELF_ELIMINATION,
  type Catalog,
  type Options,
} from "./schemas.js";
import { TILE_COUNT } from "./tiles.js";

/** The option names an input may carry. */
const INPUT_KEYS: ReadonlySet<string> = new Set(["boardSize", "handSize", "selfElimination"]);

/** The unknown keys `UNKNOWN_OPTION` may name in its detail (paths §6, as words §10.3). */
const SAFE_KEY = /^[A-Za-z0-9_]{1,64}$/u;

/** Whether `value` is one of `allowed`. */
function oneOf<T>(allowed: readonly T[], value: unknown): value is T {
  return allowed.some((item) => item === value);
}

/**
 * Resolves a creator's input to complete options (paths §6): missing fields take their defaults,
 * anything else is an error value. `undefined` and `null` mean "all defaults". Resolved options
 * resolve again to themselves (02 §2.1 rule 10).
 */
export function resolveOptions(input: unknown): Options | GameError {
  const given: unknown = input ?? {};
  if (typeof given !== "object" || given === null || Array.isArray(given)) {
    return { code: ERROR_CODES.optionsNotObject };
  }
  const fields = new Map<string, unknown>(Object.entries(given as Record<string, unknown>));
  for (const key of fields.keys()) {
    if (!INPUT_KEYS.has(key)) {
      // The key is echoed only if it looks like an option name, never arbitrary input.
      return SAFE_KEY.test(key)
        ? { code: ERROR_CODES.unknownOption, detail: { option: key } }
        : { code: ERROR_CODES.unknownOption };
    }
  }
  const boardSize = fields.get("boardSize") ?? DEFAULT_BOARD_SIZE;
  if (!oneOf(BOARD_SIZES, boardSize)) {
    return { code: ERROR_CODES.invalidOption, detail: { option: "boardSize" } };
  }
  const handSize = fields.get("handSize") ?? HAND_SIZE.default;
  if (
    typeof handSize !== "number" ||
    !Number.isInteger(handSize) ||
    handSize < HAND_SIZE.min ||
    handSize > HAND_SIZE.max
  ) {
    return { code: ERROR_CODES.invalidOption, detail: { option: "handSize" } };
  }
  const selfElimination = fields.get("selfElimination") ?? DEFAULT_SELF_ELIMINATION;
  if (!oneOf(SELF_ELIMINATION, selfElimination)) {
    return { code: ERROR_CODES.invalidOption, detail: { option: "selfElimination" } };
  }
  return { boardSize, handSize, selfElimination };
}

/** The option values and defaults, for the new-game form (paths §6). */
export function catalog(): Catalog {
  return {
    boardSize: { values: [...BOARD_SIZES], default: DEFAULT_BOARD_SIZE },
    handSize: { ...HAND_SIZE },
    selfElimination: { values: [...SELF_ELIMINATION], default: DEFAULT_SELF_ELIMINATION },
    tiles: TILE_COUNT,
  };
}

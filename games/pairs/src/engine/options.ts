/**
 * Creating a game: options and the catalog (docs/spec/games/pairs.md §7,
 * docs/spec/02-game-framework.md §2 "Creating a game"). These run in the framework at create time
 * and are never replayed.
 */
import type { GameError } from "@your-move/sdk";

import {
  DEFAULT_GRID,
  ERROR_CODES,
  FACE_COUNT,
  GRID_IDS,
  GRIDS,
  type Catalog,
  type Options,
} from "./schemas.js";

/** The unknown keys `UNKNOWN_OPTION` may name in its detail (pairs §7, as paths §6). */
const SAFE_KEY = /^[A-Za-z0-9_]{1,64}$/u;

/**
 * Resolves a creator's input to complete options (pairs §7): a missing `grid` is `4x5`, anything
 * else is an error value. `undefined` and `null` mean the defaults. Resolved options resolve again
 * to themselves (02 §2.1 rule 10).
 */
export function resolveOptions(input: unknown): Options | GameError {
  const given: unknown = input ?? {};
  if (typeof given !== "object" || given === null || Array.isArray(given)) {
    return { code: ERROR_CODES.optionsNotObject };
  }
  const fields = new Map<string, unknown>(Object.entries(given as Record<string, unknown>));
  for (const key of fields.keys()) {
    if (key !== "grid") {
      // The key is echoed only if it looks like an option name, never arbitrary input.
      return SAFE_KEY.test(key)
        ? { code: ERROR_CODES.unknownOption, detail: { option: key } }
        : { code: ERROR_CODES.unknownOption };
    }
  }
  const grid = fields.get("grid") ?? DEFAULT_GRID;
  const known = GRID_IDS.find((id) => id === grid);
  if (known === undefined) {
    return { code: ERROR_CODES.invalidOption, detail: { option: "grid" } };
  }
  return { grid: known };
}

/** The grids, the default and how many faces there are, for the new-game form (pairs §7). */
export function catalog(): Catalog {
  return {
    grid: { values: [...GRID_IDS], default: DEFAULT_GRID },
    grids: [{ ...GRIDS[0] }, { ...GRIDS[1] }, { ...GRIDS[2] }, { ...GRIDS[3] }],
    faces: FACE_COUNT,
  };
}

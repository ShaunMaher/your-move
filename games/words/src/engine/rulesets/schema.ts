/**
 * The words ruleset schema (docs/spec/games/words.md §8.1, §8.2): every number the engine uses and
 * the named behaviour variants it supports. A ruleset is data; the engine reads every value from
 * it, never from constants. Each registered ruleset is parsed with this schema when the engine
 * loads, so an invalid ruleset fails the package's tests and `pnpm games:verify` (build time).
 */
import { z } from "@your-move/sdk/schema";

/**
 * The longest word any dictionary keeps (words §9.1). A ruleset's board can't be larger, or
 * words that fit it would be missing from every dictionary.
 */
export const MAX_BOARD_SIZE = 15;

/** The blank's tile code (words §3.1). */
export const BLANK = "?";

/** Tile codes: lower-case `a`–`z`, and `?` for the blank (words §3.1). */
const TILE_CODE = /^[a-z?]$/u;

/** Premium square codes in a ruleset's `premiums` picture (words §8.1). */
const PREMIUM_CODES = {
  ".": "none",
  d: "DL",
  t: "TL",
  D: "DW",
  T: "TW",
} as const;
type PremiumCode = keyof typeof PREMIUM_CODES;
export type Premium = Exclude<(typeof PREMIUM_CODES)[PremiumCode], "none">;

/** The swap behaviour variants the engine supports (words §3.2). */
export const SWAP_ORDERS = ["drawThenReturn", "returnThenDraw"] as const;
export type SwapOrder = (typeof SWAP_ORDERS)[number];

const PREMIUM_ROW = /^[.dtDT]+$/u;

const count = z.number().int().min(0);
const positive = z.number().int().min(1);

const tileSchema = z.object({ count, points: count }).strict();

const rulesetObject = z
  .object({
    /** Stable and neutral, never a trademark; also the operator's config value (09 §1). */
    id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/u),
    version: positive,
    /** Neutral display name (words §8.3, Q16). */
    name: z.string().min(1).max(40),
    description: z.string().min(1).max(200),
    /** Must match the dictionary's language (words §9.3). */
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u),
    boardSize: z.number().int().min(2).max(MAX_BOARD_SIZE),
    /** `[row, col]` of the start square. */
    start: z.tuple([count, count]),
    rackSize: positive,
    bingoBonus: count,
    swapMinBag: count,
    swapOrder: z.enum(SWAP_ORDERS),
    scorelessTurnLimit: positive,
    minPlayers: z.number().int().min(2),
    maxPlayers: z.number().int().min(2),
    tiles: z.record(z.string().regex(TILE_CODE), tileSchema),
    /** `boardSize` rows of `boardSize` characters: `.` normal, `d` DL, `t` TL, `D` DW, `T` TW. */
    premiums: z.array(z.string().regex(PREMIUM_ROW)),
  })
  .strict();

/** A ruleset as written in its data file. */
export type RulesetData = z.input<typeof rulesetObject>;

/** The total number of tiles in a ruleset's bag (words §8.2). */
export function totalTiles(ruleset: Pick<RulesetData, "tiles">): number {
  return Object.values(ruleset.tiles).reduce((sum, tile) => sum + tile.count, 0);
}

/** The premium picture rotated a quarter turn clockwise. */
export function rotatePremiums(premiums: readonly string[]): string[] {
  const size = premiums.length;
  return premiums.map((_, row) =>
    Array.from({ length: size }, (_unused, col) => premiums[size - 1 - col]?.[row] ?? "").join(""),
  );
}

/** Whether a premium layout looks the same after a quarter turn (words §8.2). */
export function isQuarterTurnSymmetric(premiums: readonly string[]): boolean {
  const rotated = rotatePremiums(premiums);
  return premiums.every((row, index) => row === rotated[index]);
}

/** How many squares of each premium a layout has, the start square included. */
export function premiumCounts(premiums: readonly string[]): Record<Premium, number> {
  const counts: Record<Premium, number> = { DL: 0, TL: 0, DW: 0, TW: 0 };
  for (const code of premiums.join("")) {
    const premium = PREMIUM_CODES[code as PremiumCode];
    if (premium !== "none") counts[premium] += 1;
  }
  return counts;
}

/** The rules of words §8.2 that one field's type can't express. */
export const rulesetSchema = rulesetObject.superRefine((ruleset, ctx) => {
  const issue = (message: string, path: (string | number)[]): void => {
    ctx.addIssue({ code: "custom", message, path });
  };
  const size = ruleset.boardSize;
  if (ruleset.premiums.length !== size) {
    issue(`premiums must have exactly ${String(size)} rows`, ["premiums"]);
  }
  ruleset.premiums.forEach((row, index) => {
    if (row.length !== size) {
      issue(`premium row must have exactly ${String(size)} squares`, ["premiums", index]);
    }
  });
  if (
    ruleset.premiums.length === size &&
    ruleset.premiums.every((row) => row.length === size) &&
    !isQuarterTurnSymmetric(ruleset.premiums)
  ) {
    issue("the premium layout must be symmetric under a quarter turn", ["premiums"]);
  }
  const [row, col] = ruleset.start;
  if (row >= size || col >= size) issue("the start square must be on the board", ["start"]);
  if (ruleset.maxPlayers < ruleset.minPlayers) {
    issue("maxPlayers must be at least minPlayers", ["maxPlayers"]);
  }
  if (ruleset.rackSize > size) {
    issue("a full rack must fit in one line of the board", ["rackSize"]);
  }
  if (ruleset.swapOrder === "drawThenReturn" && ruleset.swapMinBag < ruleset.rackSize) {
    // Replacements are drawn before the swapped tiles go back, so a full-rack swap needs a full
    // rack's worth of tiles in the bag (words §3.2).
    issue("drawThenReturn needs swapMinBag of at least rackSize", ["swapMinBag"]);
  }
  if (totalTiles(ruleset) < ruleset.rackSize * ruleset.maxPlayers) {
    issue("there must be enough tiles to fill every rack", ["tiles"]);
  }
  const blank = ruleset.tiles[BLANK];
  if (blank !== undefined && blank.points !== 0) {
    issue("blanks are worth 0 points", ["tiles", BLANK, "points"]);
  }
});

/** A validated ruleset (words §8.1). */
export type Ruleset = z.output<typeof rulesetSchema>;

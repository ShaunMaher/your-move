/**
 * The hooks the generic test kit drives the words game with (docs/spec/02-game-framework.md §6,
 * games/words.md §10.6). They are part of the contract (02 §2 `test`), so they ship with the
 * engine and stay pure.
 */
import {
  isGameError,
  shuffle,
  type GameTestHooks,
  type OptionsContext,
  type RandomSource,
  type ResourceMeta,
  type Resources,
  type Seat,
  type WorstCase,
} from "@your-move/sdk";

import { at } from "./at.js";
import { emptyBoard, type BoardTile } from "./board.js";
import { candidatePlay, findPlay, placeTiles, randomLetter, sample } from "./bot.js";
import { KIT_WORDS } from "./kit-words.js";
import { settings } from "./options.js";
import { check } from "./rules.js";
import { MAX_BOARD_SIZE } from "./rulesets/schema.js";
import { configSchema, type Action, type Options } from "./schemas.js";
import { allTiles, rackOf, rulesetOf, setup, type State } from "./state.js";

/** The id of the kit dictionary (`kit-words.ts`) in the kit's resource catalog. */
export const KIT_DICTIONARY_ID = "kit";

/** The kit dictionary's words, as a set (built on first use; it never changes). */
let kitWords: ReadonlySet<string> | undefined;

/** Whether `word` is in the kit dictionary. */
export function kitHas(word: string): boolean {
  kitWords ??= new Set(KIT_WORDS.flatMap((line) => line.split(" ")));
  return kitWords.has(word);
}

/** The kit dictionary's metadata (02 §2 `ResourceMeta`). */
function kitDictionary(): ResourceMeta {
  const letters = new Set(KIT_WORDS.join("").replaceAll(" ", ""));
  return {
    kind: "dictionary",
    id: KIT_DICTIONARY_ID,
    version: 1,
    name: "Kit word list",
    language: "en",
    alphabet: [...letters].sort(),
    distribution: "public",
    source: "builtin",
  };
}

/**
 * What the kit's option resolution sees: the default config with the kit dictionary as the
 * default, and the kit dictionary as the only resource.
 */
function context(): OptionsContext {
  return {
    config: configSchema.parse({ DEFAULT_DICTIONARY: KIT_DICTIONARY_ID }),
    resources: [kitDictionary()],
  };
}

/** The kit dictionary, as `validate` and `preview` receive it. */
function resources(options: Options): Resources {
  return {
    dictionary: { id: options.dictionaryId, version: options.dictionaryVersion, has: kitHas },
  };
}

/** The defaults, and every other enabled ruleset (02 §6: each ruleset is played). */
function optionInputs(ctx: OptionsContext): readonly unknown[] {
  const { enabledRulesets, defaultRuleset } = settings(ctx.config);
  return [
    {},
    ...enabledRulesets.filter((id) => id !== defaultRuleset).map((rulesetId) => ({ rulesetId })),
  ];
}

/** A swap of 1..all of the rack's tiles. */
function randomSwap(rack: readonly string[], rng: RandomSource): Action {
  return { type: "swap", tiles: sample(rack, 1 + rng.nextInt(rack.length), rng) };
}

/**
 * A legal action: a pass or a swap about one time in ten each (when a swap is allowed),
 * otherwise a play found by sampling; if none turns up, a swap or a pass.
 */
function randomAction(state: State, seat: Seat, rng: RandomSource, res: Resources): Action {
  const ruleset = rulesetOf(state.options);
  const rack = rackOf(state, seat);
  const canSwap = state.bag.length >= ruleset.swapMinBag;
  const roll = rng.nextInt(10);
  if (roll === 0) return { type: "pass" };
  if (roll === 1 && canSwap) return randomSwap(rack, rng);
  const play = findPlay(state, seat, rng, res);
  if (play !== null) return play;
  return canSwap && rng.nextInt(2) === 0 ? randomSwap(rack, rng) : { type: "pass" };
}

/** A random tile code: any letter or a blank. */
function randomTile(rng: RandomSource): string {
  return rng.nextInt(27) === 26 ? "?" : randomLetter(rng);
}

/** A random square anywhere the action schema allows. */
function randomSquare(rng: RandomSource): { row: number; col: number } {
  return { row: rng.nextInt(MAX_BOARD_SIZE), col: rng.nextInt(MAX_BOARD_SIZE) };
}

/**
 * A schema-valid action, often illegal, biased to near-legal: plays from the rack around the
 * tiles on the board (mostly rejected for their words), the same with tiles not in the rack
 * (which must fail on the rack, never on the words, words §10.3), scattered or overlapping
 * placements, blank-letter mistakes, swaps of tiles not in the rack, and passes.
 */
function randomAnyAction(state: State, seat: Seat, rng: RandomSource): Action {
  const rack = rackOf(state, seat);
  const near = (): Action => candidatePlay(state, seat, rng) ?? { type: "pass" };
  const roll = rng.nextInt(10);
  switch (roll) {
    case 0:
      return { type: "pass" };
    case 1:
      return {
        type: "swap",
        tiles: Array.from({ length: 1 + rng.nextInt(7) }, () => randomTile(rng)),
      };
    case 2: {
      // Off-rack tiles on near-legal squares.
      const play = near();
      if (play.type !== "play") return play;
      const placements = play.placements.map((p) => {
        const tile = randomTile(rng);
        return tile === "?"
          ? { ...p, tile, letter: randomLetter(rng) }
          : { row: p.row, col: p.col, tile };
      });
      return { type: "play", placements };
    }
    case 3: {
      // Scattered squares, possibly occupied, repeated or out of line.
      const count = 1 + rng.nextInt(MAX_BOARD_SIZE);
      const tiles = Array.from({ length: count }, () =>
        rack.length > 0 && rng.nextInt(2) === 0
          ? at(rack, rng.nextInt(rack.length))
          : randomTile(rng),
      );
      return {
        type: "play",
        placements: tiles.map((tile) => ({ ...randomSquare(rng), tile })),
      };
    }
    case 4: {
      // A blank without its letter, or a letter on a tile that isn't a blank.
      const play = near();
      if (play.type !== "play") return play;
      const placements = play.placements.map((p) =>
        p.tile === "?"
          ? { row: p.row, col: p.col, tile: p.tile }
          : { ...p, letter: randomLetter(rng) },
      );
      return { type: "play", placements };
    }
    default:
      return near();
  }
}

/**
 * Deals everything `viewer` can't see at random into the same places: the bag (whose order is
 * never shown) and, while the game is in progress, the other seats' racks (every seat's for the
 * public viewer). Rack sizes, the board and everything else stay the same. Once the game is over
 * every rack is shown, so only the bag is perturbed.
 */
function perturbHidden(state: State, viewer: Seat | null, rng: RandomSource): State {
  const inProgress = state.finished === null;
  const others = state.racks.flatMap((_, seat) => (inProgress && seat !== viewer ? [seat] : []));
  const tiles = shuffle([...state.bag, ...others.flatMap((seat) => rackOf(state, seat))], rng);
  const racks = state.racks.map((rack, seat) =>
    others.includes(seat) ? tiles.splice(0, rack.length) : [...rack],
  );
  return { ...state, bag: tiles, racks };
}

/**
 * An upper bound on the transitions in a game. Every play puts at least one tile on the board for
 * good, so there are at most `min(tiles, boardSize²)` plays. Between two plays (and before the
 * first and after the last) there can be at most `scorelessTurnLimit − 1` passes and swaps in a
 * row, since each adds to the scoreless streak and the game ends when it reaches the limit
 * (words §5). One more transition is a seat leaving, which ends the game.
 */
function maxActions(options: Options): number {
  const ruleset = rulesetOf(options);
  const plays = Math.min(allTiles(ruleset).length, ruleset.boardSize ** 2);
  return plays + (plays + 1) * (ruleset.scorelessTurnLimit - 1) + 1;
}

/**
 * The words of the worst-case play: `AEROSOL` played between `ABALONE` and `LETTERS`, which
 * forms the main word and seven three-letter cross-words (AAL, BEE, ART, LOT, OSE, NOR, ELS)
 * with the whole rack: the most words a seven-tile play can form, plus the bingo bonus.
 */
const ABOVE = "abalone";
const PLAYED = "aerosol";
const BELOW = "letters";

/**
 * The most expensive inputs for the CPU budget (02 §6.6, words §10.6): a full-rack play that
 * forms eight words on a crowded centre, the same with a blank, and a swap of the whole rack
 * (which shuffles the whole bag).
 */
function worstCase(
  options: Options,
  seats: number,
  rng: RandomSource,
): readonly WorstCase<State, Action>[] {
  const start = setup({ options, seats, rng });
  const ruleset = rulesetOf(options);
  const [row, col] = ruleset.start;
  const first = col - 3;
  const pool = [...start.bag, ...start.racks.flat()];
  /** Takes these tiles out of the pool; null if one isn't there. */
  const take = (tiles: readonly string[]): string[] | null => {
    const taken: string[] = [];
    for (const tile of tiles) {
      const index = pool.indexOf(tile);
      if (index === -1) return null;
      taken.push(...pool.splice(index, 1));
    }
    return taken;
  };
  const fits =
    ruleset.rackSize === PLAYED.length &&
    row >= 1 &&
    row + 1 < ruleset.boardSize &&
    first >= 0 &&
    first + PLAYED.length <= ruleset.boardSize;
  const above = fits ? take(ABOVE.split("")) : null;
  const below = above === null ? null : take(BELOW.split(""));
  const rack = below === null ? null : take(PLAYED.split(""));
  const cases: WorstCase<State, Action>[] = [];
  if (above !== null && below !== null && rack !== null) {
    const board: (BoardTile | null)[][] = emptyBoard(ruleset);
    const lay = (r: number, tiles: readonly string[]): void => {
      tiles.forEach((tile, i) => {
        at(board, r)[first + i] = { tile, letter: tile };
      });
    };
    lay(row - 1, above);
    lay(row + 1, below);
    const others = Array.from({ length: seats - 1 }, () => pool.splice(0, ruleset.rackSize));
    const plain: State = { ...start, board, bag: [...pool], racks: [rack, ...others] };
    const squares = PLAYED.split("").map((_, i) => [row, first + i] as const);
    cases.push(
      {
        state: plain,
        seat: 0,
        action: { type: "play", placements: placeTiles(squares, rack, rng) },
      },
      { state: plain, seat: 0, action: { type: "swap", tiles: [...rack] } },
    );
    // The same play with a blank standing for its last letter.
    const blankAt = pool.indexOf("?");
    if (blankAt !== -1) {
      const bag = [...pool];
      bag[blankAt] = at(rack, rack.length - 1);
      const own = [...rack.slice(0, -1), "?"];
      const placements = placeTiles(squares, own, rng).map((p, i) =>
        p.tile === "?" ? { ...p, letter: at(PLAYED.split(""), i) } : p,
      );
      cases.push({
        state: { ...plain, bag, racks: [own, ...others] },
        seat: 0,
        action: { type: "play", placements },
      });
    }
  }
  // Without the layout (a ruleset it doesn't fit), the opening position is the only input.
  const legal = cases.filter(
    (c) => !isGameError(check(c.state, c.seat, c.action, resources(options))),
  );
  return legal.length > 0 ? legal : [{ state: start, seat: 0, action: { type: "pass" } }];
}

export const testHooks: GameTestHooks<Options, State, Action> = {
  randomAction,
  randomAnyAction,
  perturbHidden,
  hiddenInformation: true,
  maxActions,
  worstCase,
  optionInputs,
  context,
  resources,
};

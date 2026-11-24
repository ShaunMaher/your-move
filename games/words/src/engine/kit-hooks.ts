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

/**
 * The kit dictionary's words as a set. Built when a kit hook asks for it, never when the engine
 * loads: the hooks ship in the engine, but the framework and runtimes never call them (02 §6).
 */
function kitWords(): ReadonlySet<string> {
  return new Set(KIT_WORDS.flatMap((line) => line.split(" ")));
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
  const words = kitWords();
  return {
    dictionary: {
      id: options.dictionaryId,
      version: options.dictionaryVersion,
      has: (word) => words.has(word),
    },
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
 * The longest word a board can hold (words §9.1): played as its seven odd letters into the gaps
 * between its eight even letters, already on the board, so one full-rack play forms a 15-letter
 * main word, the longest dictionary lookup there is.
 */
const LONGEST = "acknowledgments";

/** Words already on the board, a rack, and where the rack's tiles go, in order. */
interface Layout {
  readonly laid: readonly { readonly row: number; readonly col: number; readonly word: string }[];
  readonly rack: string;
  readonly squares: readonly (readonly [number, number])[];
}

/**
 * A game position from `start` with `layout` arranged in it: the laid words on the board, the
 * rack in seat 0's hand, and every other tile dealt to the other racks and the bag, so the
 * tiles are still exactly the ruleset's. Null if the layout's tiles or squares don't fit.
 */
function arrange(start: State, layout: Layout): State | null {
  const ruleset = rulesetOf(start.options);
  const pool = [...start.bag, ...start.racks.flat()];
  const take = (word: string): string[] | null => {
    const taken: string[] = [];
    for (const tile of word.split("")) {
      const index = pool.indexOf(tile);
      if (index === -1) return null;
      taken.push(...pool.splice(index, 1));
    }
    return taken;
  };
  const size = ruleset.boardSize;
  const onBoard = ([row, col]: readonly [number, number]): boolean =>
    row >= 0 && col >= 0 && row < size && col < size;
  const laidSquares = layout.laid.flatMap(({ row, col, word }) =>
    word.split("").map((_, i) => [row, col + i] as const),
  );
  if (layout.rack.length !== ruleset.rackSize) return null;
  if (![...laidSquares, ...layout.squares].every(onBoard)) return null;
  const board: (BoardTile | null)[][] = emptyBoard(ruleset);
  for (const { row, col, word } of layout.laid) {
    const tiles = take(word);
    if (tiles === null) return null;
    tiles.forEach((tile, i) => {
      at(board, row)[col + i] = { tile, letter: tile };
    });
  }
  const rack = take(layout.rack);
  if (rack === null) return null;
  const others = start.racks.slice(1).map(() => pool.splice(0, ruleset.rackSize));
  return { ...start, board, bag: pool, racks: [rack, ...others] };
}

/**
 * The most expensive inputs for the CPU budget (02 §6.6, words §10.6): a full-rack play that
 * forms eight words on a crowded centre, the same with a blank, a full-rack play that forms a
 * 15-letter word, and a swap of the whole rack (which shuffles the whole bag).
 */
function worstCase(
  options: Options,
  seats: number,
  rng: RandomSource,
): readonly WorstCase<State, Action>[] {
  const start = setup({ options, seats, rng });
  const [row, col] = rulesetOf(options).start;
  const first = col - 3;
  const crowded: Layout = {
    laid: [
      { row: row - 1, col: first, word: ABOVE },
      { row: row + 1, col: first, word: BELOW },
    ],
    rack: PLAYED,
    squares: PLAYED.split("").map((_, i) => [row, first + i] as const),
  };
  const long: Layout = {
    laid: LONGEST.split("").flatMap((letter, i) =>
      i % 2 === 0 ? [{ row, col: i, word: letter }] : [],
    ),
    rack: LONGEST.split("")
      .filter((_, i) => i % 2 === 1)
      .join(""),
    squares: LONGEST.split("").flatMap((_, i) => (i % 2 === 1 ? [[row, i] as const] : [])),
  };
  const cases: WorstCase<State, Action>[] = [];
  const play = (state: State | null, layout: Layout): void => {
    if (state === null) return;
    const rack = rackOf(state, 0);
    cases.push({
      state,
      seat: 0,
      action: { type: "play", placements: placeTiles(layout.squares, rack, rng) },
    });
  };
  const plain = arrange(start, crowded);
  play(plain, crowded);
  play(arrange(start, long), long);
  if (plain !== null) {
    cases.push({ state: plain, seat: 0, action: { type: "swap", tiles: rackOf(plain, 0) } });
    // The crowded play with a blank from the bag standing for its last letter.
    const blankAt = plain.bag.indexOf("?");
    if (blankAt !== -1) {
      const rack = rackOf(plain, 0);
      const bag = [...plain.bag];
      bag[blankAt] = at(rack, rack.length - 1);
      const own = [...rack.slice(0, -1), "?"];
      const placements = placeTiles(crowded.squares, own, rng).map((p, i) =>
        p.tile === "?" ? { ...p, letter: at(PLAYED.split(""), i) } : p,
      );
      cases.push({
        state: { ...plain, bag, racks: [own, ...plain.racks.slice(1)] },
        seat: 0,
        action: { type: "play", placements },
      });
    }
  }
  // Without the layouts (a ruleset they don't fit), the opening position is the only input.
  const res = resources(options);
  const legal = cases.filter((c) => !isGameError(check(c.state, c.seat, c.action, res)));
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

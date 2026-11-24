/**
 * The kit hooks (02 §6, words §10.6): the kit dictionary, option inputs, the bot behind
 * `randomAction`, `randomAnyAction`'s near-legal mistakes, `perturbHidden`, the `maxActions`
 * bound and the worst cases.
 */
import { isGameError, type Resources } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { beforeAll, describe, expect, it } from "vitest";

import {
  board,
  conserved,
  options,
  rack,
  realDictionary,
  ruleset,
  state,
  tilesIn,
} from "../test-support.js";
import { anchors, candidatePlay, findPlay, lineSquares } from "./bot.js";
import { wordsV1 as words } from "./definition.js";
import { KIT_DICTIONARY_ID, kitHas } from "./kit-hooks.js";
import { KIT_WORDS } from "./kit-words.js";
import { configSchema, type Action } from "./schemas.js";
import { rackOf, setup, type State } from "./state.js";

const hooks = words.test;
const CLASSIC = ruleset("classic");
const [SR, SC] = CLASSIC.start;

let real: Resources;
beforeAll(async () => {
  real = (await realDictionary()).resources;
});

/** States from a few seeded random games, early to late. */
function states(id: string, res: () => Resources, games = 4): State[] {
  const found: State[] = [];
  for (let game = 0; game < games; game += 1) {
    const rng = seededRandom(1000 + game);
    let s = setup({ options: options(id), seats: 2, rng });
    while (words.result(s) === null) {
      found.push(s);
      const seat = s.turn;
      s = words.apply(s, seat, hooks.randomAction(s, seat, rng, res()), rng).state;
    }
    found.push(s);
  }
  return found;
}

describe("the kit dictionary", () => {
  it("holds only words of the real built-in list", () => {
    const words = KIT_WORDS.flatMap((line) => line.split(" "));
    expect(words.length).toBeGreaterThan(1000);
    expect(words.filter((word) => real.dictionary?.has(word) !== true)).toEqual([]);
    expect(words.every((word) => kitHas(word))).toBe(true);
    expect(kitHas("zzz")).toBe(false);
  });

  it("is what the kit's context and resources offer", () => {
    const ctx = hooks.context?.();
    expect(ctx?.resources.map((meta) => meta.id)).toEqual([KIT_DICTIONARY_ID]);
    expect(ctx?.resources[0]?.alphabet).toHaveLength(26);
    const resolved = words.resolveOptions({}, ctx ?? { config: {}, resources: [] });
    expect(resolved).toEqual(options("classic", KIT_DICTIONARY_ID));
    const res = hooks.resources?.(options("classic", KIT_DICTIONARY_ID));
    expect(res?.dictionary?.id).toBe(KIT_DICTIONARY_ID);
    expect(res?.dictionary?.has("cat")).toBe(true);
  });
});

describe("optionInputs", () => {
  it("plays the defaults and every other enabled ruleset", () => {
    expect(hooks.optionInputs({ config: configSchema.parse({}), resources: [] })).toEqual([
      {},
      { rulesetId: "casual" },
    ]);
    const ctx = { config: configSchema.parse({ DEFAULT_RULESET: "casual" }), resources: [] };
    expect(hooks.optionInputs(ctx)).toEqual([{}, { rulesetId: "classic" }]);
  });
});

describe("maxActions", () => {
  it("bounds plays by the tiles and fills the gaps between them with scoreless turns", () => {
    // classic: 100 plays at most, 5 passes or swaps around each, one exit.
    expect(hooks.maxActions(options("classic"), 2)).toBe(100 + 101 * 5 + 1);
    expect(hooks.maxActions(options("casual"), 2)).toBe(104 + 105 * 5 + 1);
  });
});

describe("randomAction", () => {
  it.each(["classic", "casual"])(
    "always validates, and plays, swaps and passes often under %s",
    (id) => {
      const counts = { play: 0, swap: 0, pass: 0 };
      let swappable = 0;
      for (const s of states(id, () => real)) {
        if (s.finished !== null) continue;
        const rng = seededRandom(s.bag.length);
        if (s.bag.length >= CLASSIC.swapMinBag) swappable += 1;
        const action = hooks.randomAction(s, s.turn, rng, real);
        expect(words.validate(s, s.turn, action, real)).toEqual({ ok: true });
        counts[action.type] += 1;
      }
      const total = counts.play + counts.swap + counts.pass;
      expect(counts.play / total).toBeGreaterThan(0.5);
      expect(counts.pass / total).toBeGreaterThan(0.05);
      expect(counts.swap / swappable).toBeGreaterThan(0.05);
    },
  );

  it("passes when nothing else is legal", () => {
    const s = {
      ...state({
        racks: [rack("q"), rack("z")],
        board: board(CLASSIC, [{ row: SR, col: SC - 1, word: "cat" }]),
      }),
      bag: [],
    };
    for (let seed = 0; seed < 20; seed += 1) {
      expect(hooks.randomAction(s, 0, seededRandom(seed), real)).toEqual({ type: "pass" });
    }
  });

  it("finds an opening play from a full rack", () => {
    const s = state({ racks: [rack("aetsrin"), rack("eeeeeee")] });
    const found = findPlay(s, 0, seededRandom(1), real);
    expect(found).not.toBeNull();
    expect(words.validate(s, 0, found as Action, real)).toEqual({ ok: true });
  });

  it("gives up on an opening it can't make", () => {
    expect(
      findPlay(state({ racks: [rack("qqq".slice(0, 1)), rack("z")] }), 0, seededRandom(1), real),
    ).toBeNull();
  });
});

describe("the bot's building blocks", () => {
  it("anchors on the start square on an empty board, else beside the tiles", () => {
    expect(anchors(CLASSIC, board(CLASSIC))).toEqual([[SR, SC]]);
    const spots = anchors(CLASSIC, board(CLASSIC, [{ row: 0, col: 0, word: "at" }]));
    expect(spots).toEqual([
      [0, 2],
      [1, 0],
      [1, 1],
    ]);
  });

  it("lays a line through an anchor, skipping filled squares, or gives up at the edge", () => {
    const grid = board(CLASSIC, [{ row: 0, col: 1, word: "a" }]);
    expect(lineSquares(CLASSIC, grid, [0, 0], false, 2, 0)).toEqual([
      [0, 0],
      [0, 2],
    ]);
    expect(lineSquares(CLASSIC, grid, [0, 0], false, 2, 1)).toBeNull();
    expect(lineSquares(CLASSIC, grid, [0, 0], true, 3, 0)).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
  });

  it("makes no candidate from an empty rack", () => {
    const s = {
      ...state({ racks: [[], rack("e")] }),
      board: board(CLASSIC, [{ row: SR, col: SC, word: "at" }]),
    };
    expect(candidatePlay(s, 0, seededRandom(1))).toBeNull();
  });
});

describe("randomAnyAction", () => {
  it("is schema-valid, mostly illegal, and never fails on words for tiles not in the rack", () => {
    const codes = new Map<string, number>();
    for (const s of states("classic", () => real, 2)) {
      if (s.finished !== null) continue;
      const rng = seededRandom(s.bag.length + 7);
      for (let i = 0; i < 10; i += 1) {
        const action = hooks.randomAnyAction(s, s.turn, rng);
        expect(words.actionSchema.safeParse(action).success).toBe(true);
        const verdict = words.validate(s, s.turn, action, real);
        const key = isGameError(verdict)
          ? `${verdict.code}:${JSON.stringify(verdict.detail ?? "")}`
          : "ok";
        codes.set(key, (codes.get(key) ?? 0) + 1);
        if (isGameError(verdict) && verdict.code === "INVALID_WORDS" && action.type === "play") {
          const left = [...rackOf(s, s.turn)];
          for (const p of action.placements) {
            expect(left).toContain(p.tile);
            left.splice(left.indexOf(p.tile), 1);
          }
        }
      }
    }
    const seen = [...codes.keys()].join(" ");
    for (const expected of [
      "ok",
      "INVALID_WORDS",
      "TILE_NOT_IN_RACK",
      "SQUARE_OCCUPIED",
      "NOT_IN_LINE",
      "BLANK_NEEDS_LETTER",
      "LETTER_ON_NON_BLANK",
      "SWAP_NOT_ALLOWED",
    ]) {
      expect(seen).toContain(expected);
    }
  });
});

describe("perturbHidden", () => {
  let s: State;
  beforeAll(() => {
    s = states("classic", () => real, 1)[20]!;
  });

  it.each([0, 1])("re-deals what seat %i can't see and keeps everything it can", (viewer) => {
    const other = 1 - viewer;
    const changed = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1) {
      const p = hooks.perturbHidden(s, viewer, seededRandom(seed));
      expect(conserved(p, CLASSIC)).toBe(true);
      expect(p.racks[viewer]).toEqual(s.racks[viewer]);
      expect(p.racks[other]).toHaveLength(s.racks[other]?.length ?? -1);
      expect(p.bag).toHaveLength(s.bag.length);
      expect(words.view(p, viewer)).toEqual(words.view(s, viewer));
      changed.add(JSON.stringify(p.racks[other]));
    }
    expect(changed.size).toBeGreaterThan(1);
    expect(hooks.perturbHidden(s, viewer, seededRandom(1))).not.toBe(s);
  });

  it("re-deals every rack for the public view", () => {
    const p = hooks.perturbHidden(s, null, seededRandom(3));
    expect(tilesIn(p)).toEqual(tilesIn(s));
    expect(p.racks).not.toEqual(s.racks);
    expect(words.view(p, null)).toEqual(words.view(s, null));
  });

  it("re-deals only the bag once the game is over and the racks are shown", () => {
    const over = words.onResign(s, 0, seededRandom(1), "resign").state;
    const p = hooks.perturbHidden(over, null, seededRandom(4));
    expect(p.racks).toEqual(over.racks);
    expect([...p.bag].sort()).toEqual([...over.bag].sort());
  });
});

describe("worstCase", () => {
  it.each(["classic", "casual"])(
    "gives full-rack plays of eight words and a full swap, all legal, under %s",
    (id) => {
      const opts = options(id, KIT_DICTIONARY_ID);
      const cases = hooks.worstCase(opts, 2, seededRandom(5));
      expect(cases).toHaveLength(3);
      for (const { state: s, seat, action } of cases) {
        expect(words.toAct(s)).toContain(seat);
        expect(conserved(s, ruleset(id))).toBe(true);
        for (const res of [hooks.resources?.(opts) ?? {}, real]) {
          expect(words.validate(s, seat, action, res)).toEqual({ ok: true });
        }
        const result = words.preview?.(s, seat, action, real);
        if (action.type === "play") {
          expect(result).toMatchObject({ bingo: true });
          expect((result as { words: unknown[] }).words).toHaveLength(8);
        }
      }
    },
  );
});

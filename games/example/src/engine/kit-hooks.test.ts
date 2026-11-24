/**
 * The test-kit hooks and the properties the generic kit checks (docs/spec/02-game-framework.md
 * §6), exercised here on seeded random games so a failure points at this package directly.
 */
import type { RandomSource, Seat } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { allCards, noRandom, OPTIONS, recording, state } from "../test-support.js";
import { at } from "./at.js";
import { exampleV1 as game } from "./definition.js";
import { actionSchema, recordSchema, viewSchema, type Options } from "./schemas.js";
import type { State } from "./state.js";

const ALL = Array.from({ length: 20 }, (_, i) => i + 1);
const hooks = game.test;

/** One step of random play: usually a legal play, sometimes a seat resigning. */
function step(s: State, rng: RandomSource): { seat: Seat; next: State } {
  const toAct = game.toAct(s);
  const seat = at(toAct, rng.nextInt(toAct.length));
  if (rng.nextInt(25) === 0) return { seat, next: game.onResign(s, seat, rng, "resign").state };
  const action = hooks.randomAction(s, seat, rng, {});
  expect(game.validate(s, seat, action, {})).toEqual({ ok: true });
  const { state: next, record } = game.apply(s, seat, action, rng);
  expect(recordSchema.parse(record)).toEqual(record);
  return { seat, next };
}

/** Plays a whole random game, calling `visit` on every state before the end. */
function playGame(options: Options, seats: number, seed: number, visit?: (s: State) => void) {
  const rng = seededRandom(seed);
  let s = game.setup({ options, seats, rng });
  let actions = 0;
  while (game.result(s) === null) {
    visit?.(s);
    s = step(s, rng).next;
    actions += 1;
    expect(allCards(s)).toEqual(ALL);
  }
  return { final: s, actions };
}

const CONFIGS: [Options, number][] = [
  [OPTIONS, 2],
  [OPTIONS, 3],
  [OPTIONS, 4],
  [{ handSize: 6, lives: 1 }, 3],
  [{ handSize: 5, lives: 3 }, 4],
];

describe("random games", () => {
  it.each(CONFIGS)("terminate within maxActions and conserve cards (%o, %i seats)", (o, n) => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const { final, actions } = playGame(o, n, seed, (s) => {
        const toAct = game.toAct(s);
        const statuses = game.seatStatus(s);
        expect(toAct.length).toBeGreaterThan(0);
        for (const seat of toAct) expect(statuses[seat]).toBe("playing");
        for (const viewer of [null, ...statuses.keys()]) viewSchema.parse(game.view(s, viewer));
      });
      expect(actions).toBeLessThanOrEqual(hooks.maxActions(o, n));
      expect(game.toAct(final)).toEqual([]);
      const ranking = game.result(final)?.ranking ?? [];
      expect(ranking.map((entry) => entry.seat).sort()).toEqual([...Array(n).keys()]);
      expect(ranking[0]?.rank).toBe(1);
    }
  });

  it("replay: the same draws give the same game", () => {
    expect(playGame(OPTIONS, 3, 99).final).toEqual(playGame(OPTIONS, 3, 99).final);
  });

  it("reshuffles during play, so the kit sees draws after setup", () => {
    let reshuffles = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      let previous: State | null = null;
      playGame({ handSize: 5, lives: 3 }, 4, seed, (s) => {
        if (previous !== null && s.discards.length < previous.discards.length) reshuffles += 1;
        previous = s;
      });
    }
    expect(reshuffles).toBeGreaterThan(0);
  });
});

describe("randomAction and randomAnyAction", () => {
  it("randomAction always validates; randomAnyAction is schema-valid and often illegal", () => {
    let illegal = 0;
    let total = 0;
    playGame(OPTIONS, 4, 5, (s) => {
      for (const seat of game.toAct(s)) {
        const rng = seededRandom(total);
        expect(game.validate(s, seat, hooks.randomAction(s, seat, rng, {}), {})).toEqual({
          ok: true,
        });
        const any = hooks.randomAnyAction(s, seat, rng);
        expect(actionSchema.parse(any)).toEqual(any);
        if ("code" in game.validate(s, seat, any, {})) illegal += 1;
        total += 1;
      }
    });
    expect(illegal).toBeGreaterThan(0);
    expect(illegal).toBeLessThan(total);
  });

  it("randomAnyAction stays schema-valid for a seat with no cards", () => {
    const s = state({ hands: [[], [2]], status: ["out", "playing"], faceUp: [7] });
    for (let seed = 0; seed < 20; seed += 1) {
      actionSchema.parse(hooks.randomAnyAction(s, 0, seededRandom(seed)));
    }
  });
});

describe("perturbHidden (02 §6.3)", () => {
  it("changes only what the viewer can't see, and the kit's observations agree", () => {
    let samples = 0;
    let changed = 0;
    playGame(OPTIONS, 3, 11, (s) => {
      for (const viewer of [null, 0, 1, 2]) {
        const rng = seededRandom(samples);
        const p = hooks.perturbHidden(s, viewer, rng);
        samples += 1;
        if (JSON.stringify(p) !== JSON.stringify(s)) changed += 1;
        expect(allCards(p)).toEqual(ALL);
        expect(game.view(p, viewer)).toEqual(game.view(s, viewer));
        expect(game.summary(p, viewer)).toEqual(game.summary(s, viewer));
        expect(game.toAct(p)).toEqual(game.toAct(s));
        expect(game.seatStatus(p)).toEqual(game.seatStatus(s));
        expect(game.result(p)).toBeNull();
        if (viewer !== null && game.toAct(s).includes(viewer)) {
          const any = hooks.randomAnyAction(s, viewer, rng);
          expect(game.validate(p, viewer, any, {})).toEqual(game.validate(s, viewer, any, {}));
          expect(game.preview?.(p, viewer, any, {})).toEqual(game.preview?.(s, viewer, any, {}));
        }
        for (const seat of game.toAct(s)) {
          const action = hooks.randomAction(s, seat, rng, {});
          // The same draws for `s` and `p`, then different ones (a transition may reshuffle).
          const same = (): RandomSource => seededRandom(samples);
          for (const other of [same, () => seededRandom(samples + 1000)]) {
            const exit = game.onResign(s, seat, same(), "resign").record;
            expect(game.onResign(p, seat, other(), "resign").record).toEqual(exit);
            expect(game.onTimeout(p, seat, other()).record).toEqual(
              game.onTimeout(s, seat, same()).record,
            );
            if ("ok" in game.validate(p, seat, action, {})) {
              expect(game.apply(p, seat, action, other()).record).toEqual(
                game.apply(s, seat, action, same()).record,
              );
            }
          }
        }
      }
    });
    expect(changed / samples).toBeGreaterThan(0.75);
  });

  it("keeps the viewer's own hand and secret play", () => {
    const s = play2(
      state({
        hands: [
          [1, 5, 9],
          [2, 6, 10],
        ],
      }),
    );
    for (let seed = 0; seed < 20; seed += 1) {
      const p = hooks.perturbHidden(s, 1, seededRandom(seed));
      expect(p.hands[1]).toEqual(s.hands[1]);
      expect(p.pending[1]).toBe(s.pending[1]);
      expect(p.pending[0]).toBeNull();
    }
  });

  it("for the public viewer, deals every hand and secret play anew", () => {
    const s = play2(
      state({
        hands: [
          [1, 5, 9],
          [2, 6, 10],
        ],
      }),
    );
    const p = hooks.perturbHidden(s, null, seededRandom(3));
    expect(p.hands.map((hand) => hand.length)).toEqual([3, 2]);
    expect(p.pending[1]).not.toBeNull();
    expect([p.hands, p.pending]).not.toEqual([s.hands, s.pending]);
  });

  it("after the end, keeps the revealed hands and shuffles only the deck and discards", () => {
    const over = state({ hands: [[1], [2]], discards: [3, 4], endReason: "cards-exhausted" });
    const p = hooks.perturbHidden(over, null, seededRandom(1));
    expect(p.hands).toEqual(over.hands);
    expect(allCards(p)).toEqual(ALL);
    expect(game.view(p, null)).toEqual(game.view(over, null));
  });
});

/** Seat 1 plays its highest card. */
function play2(s: State): State {
  return game.apply(s, 1, { card: 10 }, noRandom).state;
}

describe("maxActions and worstCase", () => {
  it("bounds every revealed card, one unrevealed play per seat and every seat leaving", () => {
    expect(hooks.maxActions(OPTIONS, 4)).toBe(28);
  });

  it("gives the first play, the round-resolving last play and one that reshuffles, all legal", () => {
    const cases = hooks.worstCase(OPTIONS, 4, seededRandom(1));
    expect(cases).toHaveLength(3);
    const [first, last, reshuffle] = cases;
    expect(first?.seat).toBe(0);
    expect(last?.seat).toBe(3);
    expect(game.toAct(last?.state ?? state({ hands: [] }))).toEqual([3]);
    for (const { state: s, seat, action } of cases) {
      expect(game.validate(s, seat, action, {})).toEqual({ ok: true });
      expect(allCards(s)).toEqual(ALL);
    }
    const { rng, draws } = recording(seededRandom(2));
    if (reshuffle) game.apply(reshuffle.state, reshuffle.seat, reshuffle.action, rng);
    expect(draws.length).toBeGreaterThan(0);
  });

  it("gives nothing for a seat count the deck can't deal", () => {
    expect(hooks.worstCase({ handSize: 6, lives: 1 }, 4, seededRandom(1))).toEqual([]);
  });
});

describe("optionInputs", () => {
  it("lists the defaults, the corners of both ranges and the largest hand four seats can hold", () => {
    const inputs = hooks.optionInputs({ config: {}, resources: [] });
    expect(inputs[0]).toEqual({});
    expect(inputs).toContainEqual({ handSize: 3, lives: 1 });
    expect(inputs).toContainEqual({ handSize: 6, lives: 3 });
    expect(inputs).toContainEqual({ handSize: 5 });
    for (const input of inputs)
      expect("code" in game.resolveOptions(input, { config: {}, resources: [] })).toBe(false);
  });
});

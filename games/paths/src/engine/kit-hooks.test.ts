import { isGameError } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { facing, game, OPTIONS, placedFor, STRAIGHT, unplaced } from "../test-support.js";
import { testHooks } from "./kit-hooks.js";
import { resolveOptions } from "./options.js";
import { validate } from "./rules.js";
import { actionSchema, optionsSchema, type Options } from "./schemas.js";
import { placeTile, seatStatus, setup } from "./state.js";

const SAFE = placedFor(STRAIGHT);

// A measured budget (ADR 0004), not Vitest's 5 s default: each `worstCase` test runs the hook's
// 150-game search several times, up to 0.8 s alone and about 4× that within a full `pnpm test` on
// a 16-thread developer machine (2026-11-28). The shared qemu64 CI runner has run comparable
// CPU-bound suites far slower than this machine (see kit.test.ts), so 60 s.
describe("the kit hooks (02 §6)", { timeout: 60_000 }, () => {
  const markers = game({ phase: "markers", markers: [facing(0, 0, 0), unplaced], turn: 1 });
  const tiles = game({
    markers: [facing(0, 2, 0), facing(5, 5, 4)],
    hands: [
      [SAFE.tileId, 1, 2],
      [3, 4, 5],
    ],
  });

  it("draws legal actions of the phase's kind for the seat to act", () => {
    const rng = seededRandom(1);
    for (let i = 0; i < 50; i += 1) {
      for (const [state, seat] of [
        [markers, 1],
        [tiles, 0],
      ] as const) {
        const action = testHooks.randomAction(state, seat, rng, {});
        expect(validate(state, seat, action)).toEqual({ ok: true });
      }
    }
  });

  it("draws schema-valid actions of both kinds, legal and illegal", () => {
    const rng = seededRandom(2);
    const codes = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      for (const [state, seat] of [
        [markers, 1],
        [tiles, 0],
      ] as const) {
        const action = testHooks.randomAnyAction(state, seat, rng);
        expect(actionSchema.parse(action)).toEqual(action);
        const verdict = validate(state, seat, action);
        codes.add(isGameError(verdict) ? verdict.code : "OK");
      }
    }
    expect([...codes].sort()).toEqual([
      "NOTCH_OCCUPIED",
      "NOT_IN_HAND",
      "OK",
      "OUT_OF_RANGE",
      "SELF_ELIMINATION_AVOIDABLE",
      "WRONG_PHASE",
    ]);
  });

  it("perturbs the deck and other hands only, keeping every count and the viewer's hand", () => {
    const rng = seededRandom(3);
    const state = setup({ options: OPTIONS, seats: 3, rng });
    const dealt = {
      ...state,
      phase: "tiles" as const,
      hands: [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],
      ],
    };
    dealt.deck = dealt.deck.filter((tile) => tile > 8);
    const perturbed = testHooks.perturbHidden(dealt, 1, rng);
    expect(perturbed.hands[1]).toEqual([3, 4, 5]);
    expect(perturbed.hands.map((hand) => hand.length)).toEqual([3, 3, 3]);
    expect(perturbed.deck).toHaveLength(dealt.deck.length);
    expect([...perturbed.deck, ...perturbed.hands.flat()].sort((a, b) => a - b)).toEqual(
      [...dealt.deck, ...dealt.hands.flat()].sort((a, b) => a - b),
    );
    expect(perturbed.hands).not.toEqual(dealt.hands);
    expect(perturbed.board).toEqual(dealt.board);
    expect(perturbed.markers).toEqual(dealt.markers);
    for (const hand of perturbed.hands) expect(hand).toEqual([...hand].sort((a, b) => a - b));
  });

  it("perturbs only the deck once the game is over, when the hands are on show", () => {
    const over = { ...tiles, endReason: "board-full" as const, turn: null };
    const perturbed = testHooks.perturbHidden(over, null, seededRandom(4));
    expect(perturbed.hands).toEqual(over.hands);
    expect([...perturbed.deck].sort((a, b) => a - b)).toEqual(over.deck);
  });

  it.each([1, 2, 3, 4, 5])(
    "reorders the deck itself, not only the hands, wherever its order is the only secret (seed %i)",
    (seed) => {
      const fresh = setup({ options: OPTIONS, seats: 3, rng: seededRandom(seed) });
      // Only the viewer holds tiles, so nothing but the deck can change.
      const alone = game({
        markers: [facing(0, 2, 0), facing(5, 5, 4), facing(5, 4, 4)],
        hands: [[1, 2, 3], [], []],
      });
      const over = { ...tiles, endReason: "board-full" as const, turn: null };
      for (const [state, viewer] of [
        [fresh, null],
        [fresh, 0],
        [alone, 0],
        [over, null],
      ] as const) {
        const perturbed = testHooks.perturbHidden(state, viewer, seededRandom(100 + seed));
        expect(perturbed.deck).not.toEqual(state.deck);
        expect([...perturbed.deck].sort((a, b) => a - b)).toEqual(
          [...state.deck].sort((a, b) => a - b),
        );
        expect(perturbed.hands).toEqual(state.hands);
      }
    },
  );

  it("bounds a game by its markers, its tiles and one exit per player", () => {
    expect(testHooks.maxActions(OPTIONS, 2)).toBe(39);
    expect(testHooks.maxActions(OPTIONS, 8)).toBe(51);
  });

  it("plays option inputs that all resolve, covering each hand size and both variants", () => {
    const resolved = testHooks
      .optionInputs({ config: {}, resources: [] })
      .map((input) => optionsSchema.parse(resolveOptions(input)));
    expect(new Set(resolved.map((options) => options.handSize))).toEqual(new Set([1, 2, 3]));
    expect(new Set(resolved.map((options) => options.selfElimination))).toEqual(
      new Set(["avoidIfPossible", "allowed"]),
    );
  });

  it.each([2, 3, 5, 8])(
    "keeps one input per position at %i players, under either variant and several seeds",
    (seats) => {
      for (const selfElimination of ["avoidIfPossible", "allowed"] as const) {
        for (const seed of [1, 2, 3]) {
          const options = { ...OPTIONS, handSize: 1, selfElimination } satisfies Options;
          const cases = testHooks.worstCase(options, seats, seededRandom(seats * 10 + seed));
          expect(new Set(cases.map(({ state }) => state)).size).toBe(cases.length);
        }
      }
    },
  );

  it.each([2, 3, 5, 8])(
    "finds legal late-game worst cases at %i players, one of them putting the mover out",
    (seats) => {
      for (const options of [OPTIONS, { ...OPTIONS, handSize: 1 } satisfies Options]) {
        const cases = testHooks.worstCase(options, seats, seededRandom(seats));
        expect(cases.length).toBeGreaterThanOrEqual(1);
        // One input per state searched: the inputs are different positions, not one repeated.
        expect(new Set(cases.map(({ state }) => state)).size).toBe(cases.length);
        for (const { state, seat, action } of cases) {
          expect(seatStatus(state)).toHaveLength(seats);
          expect(state.turn).toBe(seat);
          expect(validate(state, seat, action)).toEqual({ ok: true });
        }
        const eliminating = cases.filter(({ state, seat, action }) => {
          if (action.type !== "place-tile") return false;
          return placeTile(state, seat, action, seededRandom(1)).record.eliminated.includes(seat);
        });
        expect(eliminating.length).toBeGreaterThanOrEqual(1);
      }
    },
  );
});

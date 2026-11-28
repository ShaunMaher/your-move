import { isGameError, type RandomSource, type Seat } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { flipAt, game, noRandom } from "../test-support.js";
import { pairsV1 as def } from "./definition.js";
import { hiddenCards, testHooks, WORST_KINDS, worstCases } from "./kit-hooks.js";
import { resolveOptions } from "./options.js";
import { validate } from "./rules.js";
import { actionSchema, GRIDS, optionsSchema, type Action } from "./schemas.js";
import type { State } from "./state.js";

/** A source whose shuffles leave everything in place: each draw is its largest value. */
const identity: RandomSource = { nextInt: (max) => max - 1 };

/** A state mid-way through a seeded random game of `grid` (no seat leaving). */
function midGame(
  grid: (typeof GRIDS)[number]["id"],
  seats: number,
  seed: number,
  steps: number,
): State {
  const rng = seededRandom(seed);
  let state = def.setup({ options: { grid }, seats, rng });
  for (let i = 0; i < steps && state.turn !== null; i += 1) {
    state = def.apply(
      state,
      state.turn,
      testHooks.randomAction(state, state.turn, rng, {}),
      rng,
    ).state;
  }
  return state;
}

describe("randomAction (pairs §8.7)", () => {
  it("draws every legal flip, missed cards included, uniformly, and nothing else", () => {
    const state = game({
      seats: 3,
      lastMiss: { seat: 1, cards: [4, 6] },
      matched: [
        [0, 0],
        [1, 0],
      ],
    });
    const rng = seededRandom(1);
    const counts = new Map<string, number>();
    const draws = 18_000;
    for (let i = 0; i < draws; i += 1) {
      const action = testHooks.randomAction(state, 0, rng, {});
      expect(validate(state, 0, action)).toEqual({ ok: true });
      const key = `${String(action.row)},${String(action.column)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // 18 legal cards (20 less the matched pair), each about 1000 times.
    expect(counts.size).toBe(18);
    expect(counts.has("1,0") && counts.has("1,2")).toBe(true);
    for (const count of counts.values()) expect(Math.abs(count - 1000)).toBeLessThan(150);
  });

  it("never offers the up card", () => {
    const state = game({ turned: 7 });
    const rng = seededRandom(2);
    for (let i = 0; i < 500; i += 1) {
      expect(testHooks.randomAction(state, 0, rng, {})).not.toEqual(flipAt(7));
    }
  });

  it("reads no face: the same flip on a state and on its perturbation, with the same draws", () => {
    for (const seed of [1, 2, 3, 4]) {
      for (const steps of [0, 5, 40, 120]) {
        const state = midGame("6x6", 3, seed, steps);
        if (state.turn === null) continue;
        const perturbed = testHooks.perturbHidden(state, null, seededRandom(seed + 50));
        for (let draw = 0; draw < 20; draw += 1) {
          const a = testHooks.randomAction(state, state.turn, seededRandom(draw), {});
          const b = testHooks.randomAction(perturbed, state.turn, seededRandom(draw), {});
          expect(b).toEqual(a);
        }
      }
    }
  });
});

describe("randomAnyAction (pairs §8.7)", () => {
  it("draws schema-valid flips, mostly on the grid, some off it and some huge", () => {
    const state = game({
      turned: 7,
      matched: [
        [0, 0],
        [1, 0],
      ],
    });
    const rng = seededRandom(3);
    const codes = new Map<string, number>();
    let huge = 0;
    for (let i = 0; i < 2000; i += 1) {
      const action = testHooks.randomAnyAction(state, 0, rng);
      expect(actionSchema.parse(action)).toEqual(action);
      if (Math.abs(action.row) > 1000 || Math.abs(action.column) > 1000) huge += 1;
      const verdict = validate(state, 0, action);
      const code = isGameError(verdict) ? verdict.code : "OK";
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
    expect([...codes.keys()].sort()).toEqual(["CARD_FACE_UP", "OK", "OUT_OF_RANGE"]);
    expect(codes.get("OK") ?? 0).toBeGreaterThan(1000);
    expect(huge).toBeGreaterThan(100);
  });
});

describe("perturbHidden (pairs §8.7)", () => {
  it("shuffles only the hidden cards' faces, the same for every viewer", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (const steps of [1, 2, 9, 30]) {
        const state = midGame("5x6", 4, seed, steps);
        const hidden = new Set(hiddenCards(state));
        const perturbed = testHooks.perturbHidden(state, null, seededRandom(seed));
        expect(Object.keys(perturbed)).toEqual(Object.keys(state));
        expect({ ...perturbed, faces: state.faces }).toEqual(state);
        state.faces.forEach((face, card) => {
          if (!hidden.has(card)) expect(perturbed.faces[card]).toBe(face);
        });
        const sorted = (faces: readonly number[]) => [...faces].sort((a, b) => a - b);
        expect(sorted(perturbed.faces)).toEqual(sorted(state.faces));
        expect(def.view(perturbed, null).faces).toEqual(def.view(state, null).faces);
        for (const viewer of [0, 1, 2, 3, null] as (Seat | null)[]) {
          expect(testHooks.perturbHidden(state, viewer, seededRandom(seed))).toEqual(perturbed);
        }
      }
    }
  });

  it("names as hidden every card neither matched, up nor in the shown missed pair", () => {
    const state = game({
      grid: "4x4",
      turn: 1,
      lastMiss: { seat: 0, cards: [2, 4] },
      matched: [
        [0, 0],
        [1, 0],
      ],
    });
    expect(hiddenCards(state)).toEqual([3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(
      hiddenCards(
        game({
          grid: "4x4",
          turned: 3,
          matched: [
            [0, 0],
            [1, 0],
          ],
        }),
      ),
    ).toEqual([2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("changes the state whenever two hidden faces differ, even when the shuffle changes nothing", () => {
    const state = game({ grid: "4x4", turned: 3 });
    const perturbed = testHooks.perturbHidden(state, 0, identity);
    // The first hidden card (0, face 0) swaps with the first later one with another face (2).
    expect(perturbed.faces.slice(0, 4)).toEqual([1, 0, 0, 1]);
    expect(perturbed.faces.slice(4)).toEqual(state.faces.slice(4));
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(testHooks.perturbHidden(state, 0, seededRandom(seed)).faces).not.toEqual(state.faces);
    }
  });

  it("leaves the state as it is when every hidden card has one face", () => {
    // The last pair: the up card and its partner, the only hidden card.
    const base = game({ grid: "4x4" });
    const matched = base.faces.flatMap((_, card) => (card < 14 ? [[card, 0] as const] : []));
    const state = game({ grid: "4x4", matched, turned: 14 });
    expect(hiddenCards(state)).toEqual([15]);
    expect(testHooks.perturbHidden(state, null, seededRandom(1))).toEqual(state);
    // Two cards left, both hidden, of one face.
    const lastTwo = game({ grid: "4x4", matched });
    expect(testHooks.perturbHidden(lastTwo, null, identity)).toEqual(lastTwo);
  });

  it("leaves a finished game alone", () => {
    const over = def.onResign(game(), 1, noRandom, "resign").state;
    expect(hiddenCards(over)).toEqual([]);
    expect(testHooks.perturbHidden(over, null, seededRandom(1))).toEqual(over);
  });
});

// A measured budget (ADR 0004): the random games here take up to 0.5 s per grid alone and a few
// times that within a full `pnpm test` (2026-11-29); 120 s for the slow CI runner.
describe("maxActions (pairs §8.7)", { timeout: 120_000 }, () => {
  it("is the move limit plus the seats plus one", () => {
    expect(testHooks.maxActions({ grid: "4x4" }, 2)).toBe(259);
    expect(testHooks.maxActions({ grid: "4x5" }, 3)).toBe(404);
    expect(testHooks.maxActions({ grid: "6x6" }, 6)).toBe(1303);
  });

  it.each(GRIDS)("bounds random games with exits on $id at every seat count", (grid) => {
    // Exits here are far more frequent than the kit's, so leaves near the limit come up often.
    for (let seats = 2; seats <= 6; seats += 1) {
      const limit = testHooks.maxActions({ grid: grid.id }, seats);
      let longest = 0;
      for (let seed = 1; seed <= 40; seed += 1) {
        const rng = seededRandom(seed * 7 + seats);
        let state = def.setup({ options: { grid: grid.id }, seats, rng });
        let transitions = 0;
        while (state.endReason === null) {
          const turn = state.turn;
          if (turn === null) throw new Error("no seat to act in progress");
          const playing = state.out.flatMap((out, seat) => (out === null ? [seat] : []));
          // Leaves are rare, except near the limit, where they test the bound's margin.
          const leaver = playing[rng.nextInt(playing.length)] ?? turn;
          const exit = rng.nextInt(state.moves > grid.moveLimit - 10 ? 4 : 400) === 0;
          state = exit
            ? def.onResign(state, leaver, rng, "resign").state
            : def.apply(state, turn, testHooks.randomAction(state, turn, rng, {}), rng).state;
          transitions += 1;
          expect(state.moves).toBe(transitions);
        }
        expect(transitions).toBeLessThanOrEqual(limit);
        longest = Math.max(longest, transitions);
      }
      expect(longest).toBeLessThanOrEqual(limit);
    }
  });
});

// A measured budget (ADR 0004): each grid plays its move-limit drive at five seat counts, well
// under a second alone (2026-11-29); 120 s for the slow CI runner.
describe("worstCase (pairs §8.7)", { timeout: 120_000 }, () => {
  it.each(GRIDS)("returns real moves of every kind on $id at 2–6 seats", (grid) => {
    for (let seats = 2; seats <= 6; seats += 1) {
      const cases = worstCases({ grid: grid.id }, seats, seededRandom(seats));
      expect([...cases.keys()]).toEqual([...WORST_KINDS]);
      expect(WORST_KINDS).toEqual(["clears-miss", "misses", "last-pair", "move-limit"]);
      for (const [kind, { state, seat, action }] of cases) {
        expect(def.seatStatus(state)).toHaveLength(seats);
        expect(def.toAct(state)).toEqual([seat]);
        expect(validate(state, seat, action)).toEqual({ ok: true });
        const after = def.apply(state, seat, action, noRandom).state;
        if (kind === "clears-miss") {
          expect(state.lastMiss).not.toBeNull();
          expect(after).toMatchObject({ lastMiss: null, endReason: null });
        } else if (kind === "misses") {
          expect(after.lastMiss).not.toBeNull();
        } else if (kind === "last-pair") {
          expect(after.endReason).toBe("all-found");
        } else {
          expect(after.endReason).toBe("move-limit");
          expect(after.moves).toBe(grid.moveLimit);
        }
      }
      expect(testHooks.worstCase({ grid: grid.id }, seats, seededRandom(seats))).toHaveLength(4);
    }
  });

  it("costs microseconds per call: the p99 of validate + apply on the worst cases", ({
    annotate,
  }) => {
    // Wall-clock per call (performance.now() is sub-microsecond on Node), after a warm-up; the
    // kit's own CPU budget check (02 §6.6) runs in kit.test.ts. Named budget: 5 ms (08 T25).
    const BUDGET_MS = 5;
    const samples: number[] = [];
    for (const { id } of GRIDS) {
      for (const { state, seat, action } of testHooks.worstCase({ grid: id }, 6, seededRandom(9))) {
        // Fresh copies of the input for every run, made outside the timed part.
        const run = (): number => {
          const copy = structuredClone(state);
          const act: Action = { ...action };
          const start = performance.now();
          if (!isGameError(def.validate(copy, seat, act, {}))) def.apply(copy, seat, act, noRandom);
          return performance.now() - start;
        };
        for (let i = 0; i < 200; i += 1) run();
        for (let i = 0; i < 500; i += 1) samples.push(run());
      }
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)] ?? Infinity;
    void annotate(`p99 of validate + apply on the worst cases: ${(p99 * 1000).toFixed(1)} µs`);
    expect(p99).toBeLessThan(BUDGET_MS);
  });
});

describe("optionInputs (pairs §8.7)", () => {
  it("plays every grid, the defaults among them", () => {
    const inputs = testHooks.optionInputs({ config: {}, resources: [] });
    expect(inputs).toContainEqual({});
    const grids = inputs.map((input) => optionsSchema.parse(resolveOptions(input)).grid);
    expect(grids.sort()).toEqual(["4x4", "4x5", "5x6", "6x6"]);
  });
});

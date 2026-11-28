/**
 * Property tests over seeded random games with exits (pairs §10): the state invariants of §8.1 at
 * every step, and an independent oracle of which cards show a face. The oracle is written from the
 * rules of pairs §3–§6 alone, shares no code with the engine, and is fed the actions applied and
 * the layout, never the records.
 */
import type { RandomSource, Seat } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { pairsV1 as def } from "./definition.js";
import { GRIDS, type Card, type GridId } from "./schemas.js";
import type { State } from "./state.js";

type Ending = "all-found" | "last-standing" | "move-limit";

/** The rules of pairs §3–§6, kept as a table player would: what lies where, and what is shown. */
class Oracle {
  private readonly found = new Map<number, Seat>();
  private first: number | null = null;
  private miss: { readonly seat: Seat; readonly a: number; readonly b: number } | null = null;
  private readonly gone = new Set<Seat>();
  private moves = 0;
  ending: Ending | null = null;
  player: Seat = 0;

  private readonly layout: readonly number[];
  private readonly seats: number;
  private readonly limit: number;

  constructor(layout: readonly number[], seats: number, limit: number) {
    this.layout = layout;
    this.seats = seats;
    this.limit = limit;
  }

  /** The next seat after `seat` that hasn't left, going round the table. */
  private after(seat: Seat): Seat {
    let next = seat;
    do next = (next + 1) % this.seats;
    while (this.gone.has(next));
    return next;
  }

  private finish(ending: Ending): void {
    this.ending = ending;
    this.first = null;
    this.miss = null;
  }

  /** The player to act turns over `card`. */
  turnOver(card: number): void {
    this.moves += 1;
    if (this.first === null) {
      // §3.1, §4: the first card goes up, and the previous miss goes face down.
      this.first = card;
      this.miss = null;
      return;
    }
    const a = this.first;
    this.first = null;
    if (this.layout[a] === this.layout[card]) {
      this.found.set(a, this.player);
      this.found.set(card, this.player);
      if (this.found.size === this.layout.length) this.finish("all-found");
      else if (this.moves >= this.limit) this.finish("move-limit");
    } else {
      this.miss = { seat: this.player, a, b: card };
      if (this.moves >= this.limit) this.finish("move-limit");
      else this.player = this.after(this.player);
    }
  }

  /** `seat` resigns, declines or times out (§5). */
  leaves(seat: Seat): void {
    this.moves += 1;
    this.gone.add(seat);
    const theirs = seat === this.player;
    if (theirs) this.first = null;
    if (this.seats - this.gone.size === 1) this.finish("last-standing");
    else if (theirs && this.moves >= this.limit) this.finish("move-limit");
    else if (theirs) this.player = this.after(seat);
  }

  /** What every card shows (§4, §8.4), in card-index order. */
  cards(): Card[] {
    return this.layout.map((face, card): Card => {
      const finder = this.found.get(card);
      if (finder !== undefined) return { state: "matched", face, by: finder };
      if (this.ending !== null) return { state: "down", face, by: null };
      if (this.first === card) return { state: "up", face, by: this.player };
      if (this.miss !== null && (this.miss.a === card || this.miss.b === card)) {
        return { state: "missed", face, by: this.miss.seat };
      }
      return { state: "down", face: null, by: null };
    });
  }

  playing(): Seat[] {
    return Array.from({ length: this.seats }, (_, seat) => seat).filter((s) => !this.gone.has(s));
  }
}

/** The §8.1 invariants, and a few the rules imply, on one state. */
function invariants(state: State, seats: number, faces: readonly number[]): void {
  expect(state.faces).toEqual(faces);
  if (state.turned !== null) expect(state.lastMiss).toBeNull();
  for (const card of [state.turned, ...(state.lastMiss?.cards ?? [])]) {
    if (card !== null) expect(state.matchedBy[card]).toBeNull();
  }
  expect(state.endReason === null).toBe(state.turn !== null);
  if (state.endReason !== null) {
    expect(state.turned).toBeNull();
    expect(state.lastMiss).toBeNull();
  } else {
    expect(state.out[state.turn ?? -1]).toBeNull();
  }
  // Both cards of a pair are found together, by one seat.
  state.faces.forEach((face, card) => {
    const partner = state.faces.findIndex((other, i) => other === face && i !== card);
    expect(state.matchedBy[partner]).toBe(state.matchedBy[card]);
  });
  expect(state.out).toHaveLength(seats);
  expect(state.moves).toBeLessThanOrEqual(def.test.maxActions(state.options, seats));
}

/** One seeded random game, a seat leaving about once in `leaveOdds` transitions, checked at every step. */
function play(
  grid: GridId,
  seats: number,
  seed: number,
  leaveOdds: number,
): { steps: number; ending: Ending } {
  const rng: RandomSource = seededRandom(seed);
  let state = def.setup({ options: { grid }, seats, rng });
  const faces = [...state.faces];
  // The grid's size and limit come from the rules table, never from the view under test.
  const { columns, moveLimit: limit } = GRIDS.find((g) => g.id === grid) ?? GRIDS[0];
  const oracle = new Oracle(faces, seats, limit);
  let steps = 0;
  for (;;) {
    invariants(state, seats, faces);
    const view = def.view(state, null);
    expect(view.cards.flat()).toEqual(oracle.cards());
    expect(view.endReason).toBe(oracle.ending);
    if (oracle.ending !== null) break;
    expect(view.turn).toBe(oracle.player);
    const playing = oracle.playing();
    if (rng.nextInt(leaveOdds) === 0) {
      const seat = playing[rng.nextInt(playing.length)] ?? 0;
      const how = rng.nextInt(3);
      state = (
        how === 0
          ? def.onTimeout(state, seat, rng)
          : def.onResign(state, seat, rng, how === 1 ? "resign" : "decline")
      ).state;
      oracle.leaves(seat);
    } else {
      const seat = oracle.player;
      const action = def.test.randomAction(state, seat, rng, {});
      expect(def.validate(state, seat, action, {})).toEqual({ ok: true });
      state = def.apply(state, seat, action, rng).state;
      oracle.turnOver(action.row * columns + action.column);
    }
    steps += 1;
  }
  return { steps, ending: oracle.ending };
}

// A measured budget (ADR 0004), not Vitest's 5 s default: each grid's games take up to 1.8 s alone
// and about 19 s within a full `pnpm test` on a 16-thread developer machine (2026-11-29). The CI
// runner is about 2.3× slower (see kit.test.ts), so 300 s is ample.
describe("invariants and the oracle of shown faces (pairs §8.1, §10)", { timeout: 300_000 }, () => {
  it.each(GRIDS.map((grid) => grid.id))(
    "hold at every step of random games with exits on %s",
    (grid) => {
      const endings = new Set<Ending>();
      for (let seats = 2; seats <= 6; seats += 1) {
        for (let seed = 1; seed <= 12; seed += 1) {
          // A leave about every 60 transitions, so most games see one or two.
          endings.add(play(grid, seats, seats * 1000 + seed, 60).ending);
        }
      }
      expect(endings).toContain("all-found");
      expect(endings).toContain("last-standing");
    },
  );

  it("holds through games that end at the move limit", () => {
    // Random play with no seat leaving: on 4 × 4 the limit ends about one game in 60, so search.
    const reached = new Set<Ending>();
    for (let seed = 1; seed <= 600 && !reached.has("move-limit"); seed += 1) {
      reached.add(play("4x4", 2, seed, 2 ** 32).ending);
    }
    expect(reached).toContain("move-limit");
  });
});

/**
 * Test helpers for the example package: random sources that refuse, record or replay draws, a state
 * builder for rules tables and a game envelope for client tests. Seeded randomness comes from the
 * testkit's `seededRandom`. Never imported by the engine, client or manifest, and left
 * out of the published files.
 */
import type { GameEnvelope, RandomSource } from "@your-move/sdk";

import { DECK_SIZE, type Options } from "./engine/schemas.js";
import type { State } from "./engine/state.js";

/** A source that must never be drawn from: proves a transition uses no randomness. */
export const noRandom: RandomSource = {
  nextInt() {
    throw new Error("drew a random value");
  },
};

/** One recorded draw: the range asked for and the value drawn. */
export interface Draw {
  readonly maxExclusive: number;
  readonly value: number;
}

/** Wraps `rng` so every value drawn is recorded in `draws`, as the framework does (02 §2.1 rule 2). */
export function recording(rng: RandomSource): { rng: RandomSource; draws: Draw[] } {
  const draws: Draw[] = [];
  return {
    draws,
    rng: {
      nextInt(maxExclusive) {
        const value = rng.nextInt(maxExclusive);
        draws.push({ maxExclusive, value });
        return value;
      },
    },
  };
}

/**
 * Replays recorded draws, as replay does (02 §5): it fails if the transition asks for a draw that
 * wasn't recorded or for a different range.
 */
export function replaying(draws: readonly Draw[]): RandomSource {
  let next = 0;
  return {
    nextInt(maxExclusive) {
      const draw = draws[next];
      next += 1;
      if (draw?.maxExclusive !== maxExclusive) throw new Error("replay asked for another draw");
      return draw.value;
    },
  };
}

/** The default options. */
export const OPTIONS: Options = { handSize: 3, lives: 2 };

/**
 * A state for a rules table: give the hands (and whatever else matters); every other card is in
 * the deck, in ascending order unless `deck` is given.
 */
export function state(fields: Partial<Omit<State, "hands">> & { hands: number[][] }): State {
  const { hands } = fields;
  const pending = fields.pending ?? hands.map(() => null);
  const used = new Set([
    ...hands.flat(),
    ...pending.filter((card) => card !== null),
    ...(fields.discards ?? []),
    ...(fields.faceUp ?? []),
  ]);
  const rest = Array.from({ length: DECK_SIZE }, (_, i) => i + 1).filter((c) => !used.has(c));
  return {
    options: OPTIONS,
    round: 1,
    deck: rest,
    pending,
    lives: hands.map(() => OPTIONS.lives),
    points: hands.map(() => 0),
    status: hands.map(() => "playing"),
    outOrder: [],
    discards: [],
    faceUp: [],
    lastRound: null,
    endReason: null,
    ...fields,
  };
}

/** Every card in a state, wherever it is. */
export function allCards(s: State): number[] {
  return [
    ...s.deck,
    ...s.hands.flat(),
    ...s.pending.filter((card) => card !== null),
    ...s.discards,
    ...s.faceUp,
  ].sort((a, b) => a - b);
}

/** A minimal active-game envelope (05 §Common types) with the given display names. */
export function envelope(names: readonly (string | null)[], yourSeat: number | null): GameEnvelope {
  return {
    id: "g1",
    gameType: "example",
    gameVersion: 1,
    options: OPTIONS,
    status: "active",
    version: 3,
    endReason: null,
    turnTimeoutDays: 3,
    seatOrder: "join",
    aiAssistance: "off",
    available: true,
    resources: [],
    players: names.map((displayName, seat) => ({
      seat,
      userId: displayName === null ? null : `u${String(seat)}`,
      displayName,
      kind: "human",
      state: "playing",
      isYou: seat === yourSeat,
      isCreator: seat === 0,
    })),
    yourSeat,
    toAct: [],
    yourTurn: false,
    yourInvitation: null,
    createdAt: 0,
    lastActionAt: null,
  };
}

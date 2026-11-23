/**
 * Test helpers for the example package: a seeded `RandomSource`, a state builder for rules tables
 * and a game envelope for client tests. Never imported by the engine, client or manifest, and left
 * out of the published files.
 */
import type { GameEnvelope, RandomSource } from "@your-move/sdk";

import { DECK_SIZE, type Options } from "./engine/schemas.js";
import type { State } from "./engine/state.js";

/** A deterministic source (mulberry32) for tests only; never for real games (08 T10). */
export function seeded(seed: number): RandomSource {
  let a = seed >>> 0;
  return {
    nextInt(maxExclusive) {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const value = ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
      return Math.floor(value * maxExclusive);
    },
  };
}

/** A source that must never be drawn from: proves a transition uses no randomness. */
export const noRandom: RandomSource = {
  nextInt() {
    throw new Error("drew a random value");
  },
};

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

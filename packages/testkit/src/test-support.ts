/**
 * A tiny correct game for testing the kit, and the broken fixture modules the kit must reject
 * (docs/spec/02-game-framework.md §6): each fixture is the correct game with one deliberate bug.
 *
 * The game: a shuffled deck of cards 1..12; each seat holds two hidden cards; seats take turns
 * playing a card face up (scoring its value) and drawing a hidden replacement while the deck lasts.
 * The game ends when every hand is empty; the highest score wins.
 */
import {
  OK,
  shuffle,
  type GameDefinition,
  type GameEngines,
  type GameError,
  type GameManifest,
  type Ok,
  type RandomSource,
  type Resources,
  type Seat,
} from "@your-move/sdk";
import { z } from "@your-move/sdk/schema";

interface ToyState {
  readonly seats: number;
  readonly deck: readonly number[];
  readonly hands: readonly (readonly number[])[];
  readonly scores: readonly number[];
  readonly turn: Seat;
  readonly out: readonly boolean[];
  readonly marker?: number;
  /** The `open` option: kept in the state, changing nothing in the correct game. */
  readonly open: boolean;
}

interface ToyOptions {
  readonly open?: boolean | undefined;
}

interface ToyAction {
  readonly card: number;
}

type ToyRecord =
  | {
      readonly kind: "played";
      readonly seat: Seat;
      readonly card: number;
      readonly drew?: number | undefined;
    }
  | { readonly kind: "left"; readonly seat: Seat; readonly reason: string };

interface ToyView {
  readonly hand: readonly number[] | null;
  readonly handSizes: readonly number[];
  readonly scores: readonly number[];
  readonly deckSize: number;
  readonly turn: Seat;
  readonly peek?: unknown;
}

type Toy = GameDefinition<
  ToyOptions,
  ToyState,
  ToyAction,
  ToyView,
  ToyRecord,
  { readonly score: number }
>;

const DECK = Array.from({ length: 12 }, (_, i) => i + 1);

const playing = (state: ToyState): Seat[] =>
  state.out.flatMap((isOut, seat) =>
    isOut || (state.hands[seat]?.length ?? 0) === 0 ? [] : [seat],
  );

const finished = (state: ToyState): boolean =>
  playing(state).length === 0 || state.out.filter((o) => !o).length < 2;

const nextTurn = (state: ToyState, from: Seat): Seat => {
  for (let step = 1; step <= state.seats; step += 1) {
    const seat = (from + step) % state.seats;
    if (playing(state).includes(seat)) return seat;
  }
  return from;
};

const leave = (
  state: ToyState,
  seat: Seat,
  reason: string,
): { state: ToyState; record: ToyRecord } => {
  const out = state.out.map((o, i) => o || i === seat);
  const left = { ...state, out };
  return {
    state: { ...left, turn: state.turn === seat ? nextTurn(left, seat) : state.turn },
    record: { kind: "left", seat, reason },
  };
};

const pick = <T>(items: readonly T[], rng: RandomSource): T =>
  items[rng.nextInt(items.length)] as T;

/** The correct toy game. */
export function toyGame(): Toy {
  return {
    type: "toy",
    version: 1,
    configSchema: z.object({}).strict(),
    optionsSchema: z.object({ open: z.boolean().optional() }).strict(),
    actionSchema: z.object({ card: z.number().int() }).strict(),
    viewSchema: z
      .object({
        hand: z.array(z.number()).nullable(),
        handSizes: z.array(z.number()),
        scores: z.array(z.number()),
        deckSize: z.number(),
        turn: z.number(),
        peek: z.unknown().optional(),
      })
      .strict(),
    recordSchema: z.union([
      z
        .object({
          kind: z.literal("played"),
          seat: z.number(),
          card: z.number(),
          drew: z.number().optional(),
        })
        .strict(),
      z.object({ kind: z.literal("left"), seat: z.number(), reason: z.string() }).strict(),
    ]),
    previewSchema: z.object({ score: z.number() }).strict(),
    catalogSchema: z.object({ maxSeats: z.number() }).strict(),
    errorCodes: ["BAD_OPTIONS", "NOT_IN_HAND"],

    resolveOptions: (input): ToyOptions | GameError => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { code: "BAD_OPTIONS" };
      }
      const { open, ...rest } = input as { open?: unknown };
      if (Object.keys(rest).length > 0 || (open !== undefined && typeof open !== "boolean")) {
        return { code: "BAD_OPTIONS" };
      }
      return open === true ? { open } : {};
    },
    catalog: () => ({ maxSeats: 3 }),
    players: () => ({ min: 2, max: 3 }),
    validateStart: (): Ok => OK,
    defaultTurnTimeoutDays: () => 3,
    resources: () => [],
    checkConfig: () => OK,

    setup({ options, seats, rng }) {
      const deck = shuffle(DECK, rng);
      return {
        seats,
        open: options.open === true,
        hands: Array.from({ length: seats }, (_, seat) => deck.slice(seat * 2, seat * 2 + 2)),
        deck: deck.slice(seats * 2),
        scores: Array.from({ length: seats }, () => 0),
        turn: 0,
        out: Array.from({ length: seats }, () => false),
      };
    },
    toAct: (state) => (finished(state) ? [] : [state.turn]),
    seatStatus: (state) => state.out.map((o) => (o ? "out" : "playing")),
    validate: (state, seat, action): Ok | GameError =>
      state.hands[seat]?.includes(action.card) === true ? OK : { code: "NOT_IN_HAND" },
    apply(state, seat, action) {
      const [drew, ...deck] = state.deck;
      const hand = [
        ...(state.hands[seat] ?? []).filter((card) => card !== action.card),
        ...(drew === undefined ? [] : [drew]),
      ];
      const next: ToyState = {
        ...state,
        deck,
        hands: state.hands.map((h, i) => (i === seat ? hand : h)),
        scores: state.scores.map((s, i) => (i === seat ? s + action.card : s)),
      };
      return {
        state: { ...next, turn: nextTurn(next, seat) },
        record: { kind: "played", seat, card: action.card },
      };
    },
    onResign: (state, seat, _rng, reason) => leave(state, seat, reason),
    onTimeout: (state, seat) => leave(state, seat, "timeout"),
    result(state) {
      if (!finished(state)) return null;
      const scored = state.scores.map((score, seat) => ({
        seat,
        score: state.out[seat] === true ? -1 : score,
      }));
      return {
        endReason: "done",
        ranking: scored.map(({ seat, score }) => ({
          seat,
          rank: 1 + scored.filter((other) => other.score > score).length,
        })),
      };
    },
    view: (state, viewer) => ({
      hand: viewer === null || finished(state) ? null : (state.hands[viewer] ?? null),
      handSizes: state.hands.map((h) => h.length),
      scores: state.scores,
      deckSize: state.deck.length,
      turn: state.turn,
    }),
    preview: (state, seat, action) =>
      state.hands[seat]?.includes(action.card) === true
        ? { score: (state.scores[seat] ?? 0) + action.card }
        : { code: "NOT_IN_HAND" },
    describe: (record) =>
      record.kind === "played"
        ? [{ seat: record.seat }, ` played ${String(record.card)}`]
        : [{ seat: record.seat }, " left"],
    summary: (state) => ({ headline: ["Scores"], scores: [...state.scores] }),
    test: {
      randomAction: (state, seat, rng) => ({ card: pick(state.hands[seat] ?? [0], rng) }),
      randomAnyAction: (state, seat, rng) => ({
        card: rng.nextInt(2) === 0 ? pick(state.hands[seat] ?? [0], rng) : pick(DECK, rng),
      }),
      perturbHidden(state, viewer, rng) {
        // Everything the viewer can't see: the deck order and other hands, keeping their sizes.
        const hidden = state.hands.flatMap((hand, seat) => (seat === viewer ? [] : hand));
        const pool = shuffle([...hidden, ...state.deck], rng);
        let at = 0;
        const take = (n: number): number[] => {
          const cards = pool.slice(at, at + n);
          at += n;
          return cards;
        };
        const hands = state.hands.map((hand, seat) => (seat === viewer ? hand : take(hand.length)));
        return { ...state, hands, deck: take(state.deck.length) };
      },
      hiddenInformation: true,
      maxActions: (_options, seats) => DECK.length + seats,
      optionInputs: () => [{}, { open: true }],
      worstCase: (options, seats, rng) => {
        const state = toyGame().setup({ options, seats, rng });
        return [{ state, seat: 0, action: { card: state.hands[0]?.[0] ?? 1 } }];
      },
    },
  };
}

export const toyManifest: GameManifest = {
  type: "toy",
  name: "Toy",
  description: "A toy game for testing the kit.",
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#36c"/></svg>',
  licence: "BSD-2-Clause",
  resources: [],
  hiddenInformation: true,
  players: { min: 2, max: 3 },
  rules: { 1: "Play a card, draw a card." },
};

/** Wraps a definition as a package's `engines` export. */
export const asEngines = (def: Toy): GameEngines => ({ [def.version]: def });

/** Marks the slow fixture's worst-case states. */
const SLOW = 99;

/** Busy work the engine can't skip: the CPU budget fixture. */
function spin(iterations: number): number {
  let x = 0;
  for (let i = 0; i < iterations; i += 1) x = (x * 31 + i) % 1000003;
  return x;
}

/**
 * The broken fixture modules (02 §6), each with the property (or `|`-separated properties) the kit
 * must fail it on. Each call
 * returns a fresh module, so module-level state in one doesn't leak into another test.
 */
export function brokenFixtures(): Record<string, { property: string; engines: () => GameEngines }> {
  const variant = (change: (toy: Toy) => Toy) => () => asEngines(change(toyGame()));
  /** Another seat's hand, which `viewer` must never see. */
  const otherHand = (s: ToyState, viewer: Seat | null): readonly number[] =>
    s.hands[viewer === null ? 0 : (viewer + 1) % s.seats] ?? [];
  return {
    "leaks other hands only late in the game": {
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        view: (s, v) =>
          s.hands.flat().length <= 2
            ? { ...toy.view(s, v), peek: otherHand(s, v) }
            : toy.view(s, v),
      })),
    },
    "leaks other hands only under a non-default option": {
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        view: (s, v) => (s.open ? { ...toy.view(s, v), peek: otherHand(s, v) } : toy.view(s, v)),
      })),
    },
    "orders a view's keys by hidden state": {
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        view: (s, v) => {
          const { hand, ...rest } = toy.view(s, v);
          return (otherHand(s, v)[0] ?? 0) % 2 === 0 ? { hand, ...rest } : { ...rest, hand };
        },
      })),
    },
    "records a choice no other seat can see": {
      property: "secrecy",
      // Scores are hidden, so the card a seat plays is its secret; the record repeats it.
      engines: variant((toy) => ({
        ...toy,
        view: (s, v) => ({ ...toy.view(s, v), scores: [] }),
        summary: () => ({ headline: ["Playing"] }),
        apply: (s, seat, a, rng) => {
          const { state, record } = toy.apply(s, seat, a, rng);
          return { state, record: { ...record, card: a.card } };
        },
      })),
    },
    "perturbs only the deck while hands are hidden": {
      // The view leaks the next seat's hand, but reordering the deck never shows it (P2-1).
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        view: (s, v) => ({ ...toy.view(s, v), peek: otherHand(s, v) }),
        test: {
          ...toy.test,
          perturbHidden: (s) => ({ ...s, deck: [...s.deck].reverse() }),
        },
      })),
    },
    "records a rare secret choice": {
      // A rare exchange (a tenth of random actions): a negative card -c puts card c under the deck
      // and draws the top card, unseen by the others; its record names the card (S2-1).
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        validate: (s, seat, a, res) =>
          a.card < 0
            ? s.hands[seat]?.includes(-a.card) === true && s.deck.length > 0
              ? OK
              : { code: "NOT_IN_HAND" }
            : toy.validate(s, seat, a, res),
        apply: (s, seat, a, rng) => {
          if (a.card >= 0) return toy.apply(s, seat, a, rng);
          const [drew = 0, ...rest] = s.deck;
          const hand = [...(s.hands[seat] ?? []).filter((c) => c !== -a.card), drew];
          return {
            state: {
              ...s,
              deck: [...rest, -a.card],
              hands: s.hands.map((h, i) => (i === seat ? hand : h)),
            },
            record: { kind: "played", seat, card: a.card },
          };
        },
        test: {
          ...toy.test,
          randomAction: (s, seat, rng, res) =>
            s.deck.length > 0 && rng.nextInt(10) === 0
              ? { card: -pick(s.hands[seat] ?? [0], rng) }
              : toy.test.randomAction(s, seat, rng, res),
          maxActions: () => 500,
        },
      })),
    },
    "never terminates, with a large maxActions": {
      property: "termination",
      engines: variant((toy) => ({
        ...toy,
        apply: (s, seat, a, rng) => {
          const { state, record } = toy.apply(s, seat, a, rng);
          return { state: { ...state, deck: [...state.deck, a.card] }, record };
        },
        test: { ...toy.test, maxActions: () => 2000 },
      })),
    },
    "returns an invalid maxActions": {
      property: "termination",
      engines: variant((toy) => ({ ...toy, test: { ...toy.test, maxActions: () => 0.5 } })),
    },
    "has no legal worst case": {
      property: "cpu",
      engines: variant((toy) => ({
        ...toy,
        test: {
          ...toy.test,
          worstCase: (options, seats, rng) =>
            toy.test.worstCase(options, seats, rng).map((c) => ({ ...c, action: { card: 99 } })),
        },
      })),
    },
    "has an empty worst case": {
      property: "cpu",
      engines: variant((toy) => ({ ...toy, test: { ...toy.test, worstCase: () => [] } })),
    },
    "leaks other hands into a view": {
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        view: (s, v) => ({ ...toy.view(s, v), peek: s.hands }),
      })),
    },
    "leaks hidden state into an error detail": {
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        validate: (s, seat, a, res) => {
          const verdict = toy.validate(s, seat, a, res);
          return "code" in verdict
            ? { code: verdict.code, detail: { deckTop: s.deck[0] ?? null } }
            : verdict;
        },
      })),
    },
    "leaks the drawn card into a record": {
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        apply: (s, seat, a, rng) => {
          const { state, record } = toy.apply(s, seat, a, rng);
          return {
            state,
            record:
              record.kind === "played" && s.deck[0] !== undefined
                ? { ...record, drew: s.deck[0] }
                : record,
          };
        },
      })),
    },
    "leaks the deck into the public view": {
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        view: (s, v) =>
          v === null
            ? { ...toy.view(s, v), peek: s.deck.length > 0 ? s.deck[0] : null }
            : toy.view(s, v),
      })),
    },
    "sets hiddenFromEveryone while its seats see different hands": {
      // Each seat sees its own hand, so the flag is false; the kit checks it at every step (02 §6.3).
      property: "secrecy",
      engines: variant((toy) => ({ ...toy, test: { ...toy.test, hiddenFromEveryone: true } })),
    },
    "sets hiddenFromEveryone while the public's view differs from the seats'": {
      // Every seat sees the same view, but the public's differs: the flag covers every viewer.
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        view: (s, v) => (v === null ? toy.view(s, null) : { ...toy.view(s, null), peek: "seated" }),
        test: { ...toy.test, hiddenFromEveryone: true },
      })),
    },
    "sets hiddenFromEveryone with different hands and a deck-only perturbHidden": {
      // The shape of review M1a P2-1: the non-vacuity count alone passed it, as the state changes.
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        test: {
          ...toy.test,
          hiddenFromEveryone: true,
          perturbHidden: (s) => ({ ...s, deck: [...s.deck].reverse() }),
        },
      })),
    },
    "sets hiddenFromEveryone while its views differ only late in the game": {
      // One view for everyone until two cards are left, then each seat's own: checked every step.
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        view: (s, v) =>
          s.hands.flat().length <= 2 ? { ...toy.view(s, null), peek: v } : toy.view(s, null),
        test: { ...toy.test, hiddenFromEveryone: true },
      })),
    },
    "sets hiddenFromEveryone while a summary leaks the next seat's hand": {
      // One view for everyone, but each seat's summary names the next seat's hand (A25-S-1); the
      // deck-only perturbation never changes a summary, so only the flag's check catches it.
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        view: (s) => toy.view(s, null),
        summary: (s, v) => ({
          headline: [v === null ? "Scores" : (s.hands[(v + 1) % s.seats] ?? []).join(",")],
          scores: [...s.scores],
        }),
        test: {
          ...toy.test,
          hiddenFromEveryone: true,
          perturbHidden: (s) => ({ ...s, deck: [...s.deck].reverse() }),
        },
      })),
    },
    "has a no-op perturbHidden": {
      property: "secrecy",
      engines: variant((toy) => ({ ...toy, test: { ...toy.test, perturbHidden: (s) => s } })),
    },
    "reads resources in setup": {
      property: "replay",
      engines: () => {
        let seen: Resources = {};
        return asEngines({
          ...toyGame(),
          validate(s, seat, a, res) {
            seen = res;
            return toyGame().validate(s, seat, a, res);
          },
          setup(ctx) {
            const state = toyGame().setup(ctx);
            return seen.dictionary?.has("x") === true ? { ...state, marker: 1 } : state;
          },
        });
      },
    },
    "is nondeterministic": {
      property: "replay",
      engines: () => {
        let calls = 0;
        const toy = toyGame();
        return asEngines({
          ...toy,
          apply(s, seat, a, rng) {
            calls += 1;
            const { state, record } = toy.apply(s, seat, a, rng);
            return { state: { ...state, marker: calls }, record };
          },
        });
      },
    },
    "never terminates": {
      property: "termination",
      engines: variant((toy) => ({
        ...toy,
        apply: (s, seat, a, rng) => {
          const { state, record } = toy.apply(s, seat, a, rng);
          // The played card goes back under the deck, so hands never run out.
          return { state: { ...state, deck: [...state.deck, a.card] }, record };
        },
      })),
    },
    "leaves toAct non-empty after the end": {
      property: "turns",
      engines: variant((toy) => ({ ...toy, toAct: (s) => [s.turn] })),
    },
    "keeps hidden state in a module-level cache shared between games": {
      // Whichever check meets the stale entry first: interleaved games, or a perturbed sample.
      property: "isolation|secrecy",
      engines: () => {
        const toy = toyGame();
        const cache = new Map<string, ToyView>();
        return asEngines({
          ...toy,
          // A per-game cache that assumes one game at a time: cleared by setup, keyed by turn.
          setup(ctx) {
            cache.clear();
            return toy.setup(ctx);
          },
          view(s, v) {
            const key = `${String(v)}/${String(s.deck.length)}/${String(s.hands.flat().length)}`;
            const hit = cache.get(key);
            if (hit !== undefined) return hit;
            const view = toy.view(s, v);
            cache.set(key, view);
            return view;
          },
        });
      },
    },
    "puts a seat in toAct that has no legal action": {
      property: "turns",
      engines: variant((toy) => ({
        ...toy,
        validate: (s, seat, a, res) =>
          s.deck.length === 3 ? { code: "NOT_IN_HAND" } : toy.validate(s, seat, a, res),
      })),
    },
    "puts a seat that can't act in a multi-seat toAct": {
      property: "turns",
      // The next seat is in toAct too, but only the seat whose turn it is may play.
      engines: variant((toy) => ({
        ...toy,
        toAct: (s) => {
          const seats = toy.toAct(s);
          const next = ((seats[0] ?? 0) + 1) % s.seats;
          return seats.length > 0 && s.out[next] === false ? [...seats, next] : seats;
        },
        validate: (s, seat, a, res) =>
          seat === s.turn ? toy.validate(s, seat, a, res) : { code: "NOT_IN_HAND" },
      })),
    },
    "returns a view that doesn't match its schema": {
      property: "schema",
      engines: variant((toy) => ({
        ...toy,
        view: (s, v) => ({ ...toy.view(s, v), turn: "mine" as unknown as number }),
      })),
    },
    "uses a reserved error code": {
      property: "schema",
      engines: variant((toy) => ({ ...toy, errorCodes: [...toy.errorCodes, "NOT_YOUR_TURN"] })),
    },
    "returns an error code it doesn't declare": {
      property: "schema",
      engines: variant((toy) => ({
        ...toy,
        validate: (s, seat, a, res) =>
          toy.validate(s, seat, a, res) === OK ? OK : { code: "NOPE" },
      })),
    },
    "keeps state that isn't plain JSON": {
      property: "schema",
      engines: variant((toy) => ({
        ...toy,
        setup: (ctx) => ({ ...toy.setup(ctx), marker: Number.NaN }),
      })),
    },
    "is too slow on its worst case": {
      property: "cpu",
      engines: variant((toy) => ({
        ...toy,
        validate: (s, seat, a, res) =>
          s.marker === SLOW && spin(3_000_000) < 0 ? OK : toy.validate(s, seat, a, res),
        test: {
          ...toy.test,
          worstCase: (options, seats, rng) =>
            toy.test
              .worstCase(options, seats, rng)
              .map((c) => ({ ...c, state: { ...c.state, marker: SLOW } })),
        },
      })),
    },
    "throws on an illegal action": {
      property: "schema",
      engines: variant((toy) => ({
        ...toy,
        validate: (s, seat, a, res) => {
          const verdict = toy.validate(s, seat, a, res);
          if (verdict !== OK) throw new Error("illegal");
          return verdict;
        },
      })),
    },
    "shows random draws in records": {
      property: "secrecy",
      engines: variant((toy) => ({
        ...toy,
        apply: (s, seat, a, rng) => {
          const { state, record } = toy.apply(s, seat, a, rng);
          return { state, record: { ...record, drew: rng.nextInt(6) } as ToyRecord };
        },
      })),
    },
  };
}

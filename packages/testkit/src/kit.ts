/**
 * The generic test kit (docs/spec/02-game-framework.md §6): plays many seeded random games through
 * every exported rules version of a game engine and checks the contract rules of 02 §2.1 that can
 * be checked from outside the module. Every failure names its property and, where it came from a
 * game, the seed that reproduces it.
 */
import {
  isGameError,
  listSummarySchema,
  recordRandom,
  replayRandom,
  textSchema,
  type AnyGameDefinition,
  type GameEngines,
  type RandomSource,
  type Resources,
  type Seat,
} from "@your-move/sdk";

import { canonical, isPlainJson, sameJson } from "./canonical.js";
import { resolveCombos } from "./combos.js";
import { checkCpu } from "./cpu.js";
import { checkManifest } from "./manifest.js";
import { scriptedRandom, seededRandom } from "./random.js";
import {
  GameAborted,
  Reporter,
  errorName,
  jsonClone,
  viewers,
  type Combo,
  type Where,
} from "./report.js";
import type { KitOptions, KitReport } from "./types.js";

export type { KitFailure, KitMode, KitOptions, KitProperty, KitReport } from "./types.js";

/** Games per rules version in fast mode, spread over its option sets and seat counts. */
const FAST_GAMES = 300;
/** Games per option set and seat count in full mode. */
const FULL_GAMES = 1000;
/**
 * In full mode, games at these positions in each run of {@link EVERY_STEP_PERIOD} are checked for
 * secrecy at every step: a tenth of the games, one with seats leaving and one without.
 */
const EVERY_STEP_PERIOD = 20;
const EVERY_STEP_SLOTS: ReadonlySet<number> = new Set([0, 11]);
/** Secrecy samples per game, spread uniformly over the game (02 §6.3). */
const SAMPLES = { fast: 2, full: 3 } as const;
/** Exits (resign, decline, timeout) happen at most once per this many steps, on average. */
const MIN_EXIT_ODDS = 40;
/** Possibly-illegal actions tried per step and per secrecy sample. */
const ANY_ACTIONS = 2;
/** Tries at finding a second legal action that differs from the first (02 §6.3). */
const OTHER_ACTION_TRIES = 4;
/** The largest `maxActions` the kit accepts: beyond it, random play can't show termination. */
const MAX_ACTIONS_CAP = 1_000_000;

interface LogEntry {
  readonly kind: "action" | "resign" | "decline" | "timeout";
  readonly seat: Seat;
  readonly action?: unknown;
  readonly draws: readonly number[];
}

/** One in-progress point of a game, kept for a secrecy check after the game ends. */
interface Sample {
  readonly state: unknown;
  readonly toAct: readonly Seat[];
  readonly acted: readonly Seat[];
}

/** How one game is played. */
interface GamePlan {
  /** Whether seats may leave (resign, decline, time out) during the game. */
  readonly exits: boolean;
  /** Whether secrecy is checked at every step rather than at sampled ones. */
  readonly everyStep: boolean;
}

/** What a game looked like from outside at one point: used by the isolation check. */
type Observation = string;

/** Plays games through one engine and checks them (02 §6.2–§6.5, §6.7). */
class Kit extends Reporter {
  games = 0;
  /**
   * Secrecy samples taken while a game was in progress; how many changed some other viewer's
   * view; how many changed the state at all (02 §6.3 non-vacuity).
   */
  private samples = 0;
  private viewPerturbed = 0;
  private statePerturbed = 0;
  /** The resources of the combo being played (`test.resources`). */
  private resources: Resources = {};

  readonly options: KitOptions;

  constructor(options: KitOptions) {
    super();
    this.options = options;
  }

  // --- one game ------------------------------------------------------------------------------

  /** Plays one seeded game with every per-step check. */
  play(combo: Combo, seed: number, plan: GamePlan): void {
    const steps = this.game(combo, seed, plan);
    try {
      while (steps.next().done !== true) {
        // Each step is one transition; nothing to do between them.
      }
    } catch (error) {
      // A failure was reported where it happened. Anything else is module output the kit
      // couldn't even inspect (e.g. seatStatus returning no array).
      if (!(error instanceof GameAborted)) {
        this.fail("schema", `module output the kit can't read: ${errorName(error)}`, {
          version: combo.def.version,
          seats: combo.seats,
          seed,
        });
      }
    }
  }

  /**
   * One seeded game with every per-step check, paused after each transition so the isolation
   * check can interleave two games. `observe` sees everything a client could.
   */
  private *game(
    combo: Combo,
    seed: number,
    plan: GamePlan,
    observe?: (observation: Observation) => void,
  ): Generator<void, void> {
    const { def, options, seats } = combo;
    this.resources = combo.resources;
    const where = { version: def.version, seats, seed };
    const rng = seededRandom(seed);
    // Secrecy samples and their perturbations draw from their own source, so the game is the
    // same whichever points are sampled.
    const sampler = seededRandom(seed ^ 0x2545f491);
    const recording = recordRandom(seededRandom(seed ^ 0x5bd1e995));
    let state: unknown = this.call("schema", "setup", where, () =>
      def.setup({ options, seats, rng: recording.rng }),
    );
    state = this.roundTrip(state, "setup", where);
    const setupDraws = [...recording.draws];
    const log: LogEntry[] = [];
    const acted = new Set<Seat>();
    const out = new Set<Seat>();
    const limit = this.maxActions(combo, where);
    // Exits stay rare enough that a game can still run to `maxActions` (02 §6.4).
    const exitOdds = plan.exits ? Math.max(MIN_EXIT_ODDS, limit) : 0;
    const reservoir: Sample[] = [];
    const size = SAMPLES[this.options.mode];

    for (let step = 0; ; step += 1) {
      const toAct = this.turns(def, state, seats, out, where);
      this.observeViews(def, state, seats, where, observe);
      const finished = this.call("schema", "result", where, () => def.result(state)) !== null;
      if (finished) break;
      if (step >= limit) {
        this.fail(
          "termination",
          `no result after maxActions (${String(limit)}) transitions`,
          where,
        );
        throw new GameAborted();
      }
      const sample = { state: jsonClone(state), toAct, acted: [...acted] };
      if (plan.everyStep) {
        this.secrecy(combo, sample, sampler, where);
      } else if (reservoir.length < size) {
        // Reservoir sampling: every in-progress step is equally likely to be checked, early or
        // late (02 §6.3).
        reservoir.push(sample);
      } else {
        const slot = sampler.nextInt(step + 1);
        if (slot < size) reservoir[slot] = sample;
      }

      for (const seat of toAct) this.legalAction(def, state, seat, rng, where);
      const playing = this.playing(def, state, where);
      const entry = this.transition(
        combo,
        state,
        toAct,
        playing,
        acted,
        rng,
        exitOdds,
        where,
        observe,
      );
      // An exception from a transition is a bug (02 §2.1 rule 3).
      const result = this.call("schema", entry.kind, where, entry.run);
      this.record(def, result.record, where, observe);
      state = this.roundTrip(result.state, entry.kind, where);
      log.push({ ...entry.log, draws: [...entry.draws()] });
      if (entry.log.kind === "action") acted.add(entry.log.seat);
      if (entry.log.kind !== "action") {
        const status = this.call("turns", "seatStatus", where, () => def.seatStatus(state));
        this.check(
          status[entry.log.seat] === "out",
          "turns",
          `seat ${String(entry.log.seat)} is still playing after ${entry.log.kind}`,
          where,
        );
      }
      yield;
    }
    this.replay(def, options, seats, setupDraws, log, state, where);
    for (const sample of reservoir) this.secrecy(combo, sample, sampler, where);
  }

  /** `maxActions`, which must be a positive safe integer no larger than the cap (02 §6.4). */
  private maxActions(combo: Combo, where: Where): number {
    const { def, options, seats } = combo;
    const limit = this.call("termination", "maxActions", where, () =>
      def.test.maxActions(options, seats),
    );
    this.check(
      Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_ACTIONS_CAP,
      "termination",
      `maxActions must be a whole number from 1 to ${String(MAX_ACTIONS_CAP)}; it returned ${String(limit)}`,
      where,
    );
    return limit;
  }

  /** Chooses and prepares the next transition: usually an action, sometimes a seat leaving. */
  private transition(
    combo: Combo,
    state: unknown,
    toAct: readonly Seat[],
    playing: readonly Seat[],
    acted: ReadonlySet<Seat>,
    rng: RandomSource,
    exitOdds: number,
    where: Where,
    observe?: (observation: Observation) => void,
  ): {
    log: Omit<LogEntry, "draws">;
    run: () => { state: unknown; record: unknown };
    draws: () => readonly number[];
    kind: string;
  } {
    const { def } = combo;
    const recording = recordRandom(seededRandom(rng.nextInt(2 ** 32)));
    const leaver = playing[rng.nextInt(Math.max(1, playing.length))];
    if (leaver !== undefined && exitOdds > 0 && rng.nextInt(exitOdds) === 0) {
      // A seat that hasn't acted declines only if enough would remain: otherwise the framework
      // ends the game as declined without calling the module (02 §4). It may resign instead.
      const canDecline = !acted.has(leaver) && playing.length - 1 >= combo.min;
      if (canDecline && rng.nextInt(2) === 0) {
        return {
          kind: "onResign(decline)",
          log: { kind: "decline", seat: leaver },
          run: () => def.onResign(state, leaver, recording.rng, "decline"),
          draws: () => recording.draws,
        };
      }
      // Timeouts reach the module only for seats that have acted (02 §4).
      if (acted.has(leaver) && toAct.includes(leaver) && rng.nextInt(2) === 0) {
        return {
          kind: "onTimeout",
          log: { kind: "timeout", seat: leaver },
          run: () => def.onTimeout(state, leaver, recording.rng),
          draws: () => recording.draws,
        };
      }
      return {
        kind: "onResign(resign)",
        log: { kind: "resign", seat: leaver },
        run: () => def.onResign(state, leaver, recording.rng, "resign"),
        draws: () => recording.draws,
      };
    }

    const seat = toAct[rng.nextInt(toAct.length)] ?? 0;
    for (let i = 0; i < ANY_ACTIONS; i += 1) {
      const any = this.call("schema", "randomAnyAction", where, () =>
        def.test.randomAnyAction(state, seat, rng),
      );
      this.check(
        def.actionSchema.safeParse(any).success,
        "schema",
        "randomAnyAction returned an action that doesn't match actionSchema",
        where,
      );
      // Evaluated whether or not anyone observes: these are checks too.
      const verdict = this.validate(def, state, seat, any, where);
      const preview = this.preview(def, state, seat, any, where);
      observe?.(`any ${canonical(verdict)} ${canonical(preview)}`);
    }
    const action = this.legalAction(def, state, seat, rng, where);
    const preview = this.preview(def, state, seat, action, where);
    observe?.(`preview ${canonical(preview)}`);
    return {
      kind: "apply",
      log: { kind: "action", seat, action },
      run: () => def.apply(state, seat, action, recording.rng),
      draws: () => recording.draws,
    };
  }

  /** A `randomAction` for `seat`, which must match the schema and validate (02 §6.5). */
  private legalAction(
    def: AnyGameDefinition,
    state: unknown,
    seat: Seat,
    rng: RandomSource,
    where: Where,
  ): unknown {
    const action = this.call("turns", "randomAction", where, () =>
      def.test.randomAction(state, seat, rng, this.resources),
    );
    this.check(
      def.actionSchema.safeParse(action).success,
      "schema",
      "randomAction returned an action that doesn't match actionSchema",
      where,
    );
    const verdict = this.validate(def, state, seat, action, where);
    this.check(
      !isGameError(verdict),
      "turns",
      `seat ${String(seat)} is in toAct but its randomAction doesn't validate (${isGameError(verdict) ? verdict.code : ""})`,
      where,
    );
    return action;
  }

  private validate(
    def: AnyGameDefinition,
    state: unknown,
    seat: Seat,
    action: unknown,
    where: Where,
  ): unknown {
    const verdict = this.call("schema", "validate", where, () =>
      def.validate(state, seat, action, this.resources),
    );
    if (isGameError(verdict)) this.errorCode(def, verdict.code, "validate", where);
    else
      this.check(
        sameJson(verdict, { ok: true }),
        "schema",
        "validate must return OK or a GameError",
        where,
      );
    return verdict;
  }

  private preview(
    def: AnyGameDefinition,
    state: unknown,
    seat: Seat,
    action: unknown,
    where: Where,
  ): unknown {
    if (def.preview === undefined) return undefined;
    const result = this.call("schema", "preview", where, () =>
      def.preview?.(state, seat, action, this.resources),
    );
    if (isGameError(result)) this.errorCode(def, result.code, "preview", where);
    else
      this.check(
        def.previewSchema?.safeParse(result).success ?? false,
        "schema",
        "preview result doesn't match previewSchema",
        where,
      );
    return result;
  }

  private record(
    def: AnyGameDefinition,
    record: unknown,
    where: Where,
    observe?: (o: Observation) => void,
  ): void {
    this.check(
      def.recordSchema.safeParse(record).success,
      "schema",
      "a record doesn't match recordSchema",
      where,
    );
    const text = this.call("schema", "describe", where, () => def.describe(record));
    this.check(
      textSchema.safeParse(text).success,
      "schema",
      "describe() didn't return Text",
      where,
    );
    observe?.(`record ${canonical(record)} ${canonical(text)}`);
  }

  /** States are stored as JSON (02 §5): every state must survive the round trip unchanged. */
  private roundTrip(state: unknown, after: string, where: Where): unknown {
    this.check(
      isPlainJson(state),
      "schema",
      `the state after ${after} isn't plain JSON data`,
      where,
    );
    return jsonClone(state);
  }

  // --- turn sanity (02 §6.5) -----------------------------------------------------------------

  private playing(def: AnyGameDefinition, state: unknown, where: Where): Seat[] {
    const status = this.call("turns", "seatStatus", where, () => def.seatStatus(state));
    return status.flatMap((value, seat) => (value === "playing" ? [seat] : []));
  }

  private turns(
    def: AnyGameDefinition,
    state: unknown,
    seats: number,
    out: Set<Seat>,
    where: Where,
  ): Seat[] {
    const toAct = this.call("turns", "toAct", where, () => def.toAct(state));
    const status = this.call("turns", "seatStatus", where, () => def.seatStatus(state));
    const result = this.call("turns", "result", where, () => def.result(state));
    this.check(
      status.length === seats &&
        (status as readonly unknown[]).every((value) => value === "playing" || value === "out"),
      "turns",
      "seatStatus must give playing or out for every seat",
      where,
    );
    this.check(
      Array.isArray(toAct) &&
        new Set(toAct).size === toAct.length &&
        toAct.every((seat) => status[seat] === "playing"),
      "turns",
      `toAct ${canonical(toAct)} must be distinct seats that are playing`,
      where,
    );
    for (const seat of out) {
      this.check(
        status[seat] === "out",
        "turns",
        `seat ${String(seat)} returned to playing after being out`,
        where,
      );
    }
    status.forEach((value, seat) => {
      if (value === "out") out.add(seat);
    });
    this.check(
      (toAct.length === 0) === (result !== null),
      "turns",
      result === null
        ? "toAct is empty but the game has no result"
        : "toAct isn't empty after the game ended",
      where,
    );
    if (result !== null) this.ranking(result, seats, where);
    return toAct;
  }

  /** Standard competition ranking (02 §4): each rank is one more than the number of better seats. */
  private ranking(
    result: NonNullable<ReturnType<AnyGameDefinition["result"]>>,
    seats: number,
    where: Where,
  ): void {
    const { ranking, endReason } = result;
    const ranks = ranking.map((entry) => entry.rank);
    const valid =
      typeof endReason === "string" &&
      endReason.length > 0 &&
      new Set(ranking.map((entry) => entry.seat)).size === ranking.length &&
      ranking.every(
        (entry) =>
          Number.isInteger(entry.seat) &&
          entry.seat >= 0 &&
          entry.seat < seats &&
          entry.rank === 1 + ranks.filter((rank) => rank < entry.rank).length,
      );
    this.check(
      valid,
      "schema",
      `result() ${canonical(result)} isn't a standard competition ranking`,
      where,
    );
  }

  // --- views ---------------------------------------------------------------------------------

  private observeViews(
    def: AnyGameDefinition,
    state: unknown,
    seats: number,
    where: Where,
    observe?: (o: Observation) => void,
  ): void {
    for (const viewer of viewers(seats)) {
      const view = this.call("schema", "view", where, () => def.view(state, viewer));
      this.check(
        def.viewSchema.safeParse(view).success,
        "schema",
        `view for ${String(viewer)} doesn't match viewSchema`,
        where,
      );
      const summary = this.call("schema", "summary", where, () => def.summary(state, viewer));
      this.check(
        listSummarySchema.safeParse(summary).success,
        "schema",
        `summary for ${String(viewer)} isn't a ListSummary`,
        where,
      );
      observe?.(`view ${String(viewer)} ${canonical(view)} ${canonical(summary)}`);
    }
  }

  // --- secrecy (02 §6.3) ---------------------------------------------------------------------

  private secrecy(combo: Combo, sample: Sample, rng: RandomSource, where: Where): void {
    const { def, seats } = combo;
    const { state, toAct } = sample;
    const acted = new Set(sample.acted);
    const before = canonical(state);
    for (const viewer of viewers(seats)) {
      const perturbed = this.call("secrecy", "perturbHidden", where, () =>
        def.test.perturbHidden(state, viewer, seededRandom(rng.nextInt(2 ** 32))),
      );
      this.check(
        canonical(state) === before,
        "secrecy",
        "perturbHidden changed the state it was given",
        where,
      );
      this.tally(def, state, perturbed, viewer, seats, before, where);
      const who = viewer === null ? "the public" : `seat ${String(viewer)}`;
      const same = (what: string, fn: (s: unknown) => unknown): void => {
        // An exception is a bug whatever the state (02 §2.1 rule 3), so it counts as schema.
        const a = this.call("schema", what, where, () => fn(state));
        const b = this.call("schema", `${what} (perturbed)`, where, () => fn(perturbed));
        this.check(
          sameJson(a, b),
          "secrecy",
          `${what} for ${who} depends on information hidden from ${who}`,
          where,
        );
      };
      same("view", (s) => def.view(s, viewer));
      same("summary", (s) => def.summary(s, viewer));
      same("toAct", (s) => def.toAct(s));
      same("seatStatus", (s) => def.seatStatus(s));
      same("result() === null", (s) => def.result(s) === null);

      if (viewer !== null && toAct.includes(viewer)) {
        const actions = [
          this.call("secrecy", "randomAction", where, () =>
            def.test.randomAction(state, viewer, rng, this.resources),
          ),
          ...Array.from({ length: ANY_ACTIONS }, () =>
            this.call("secrecy", "randomAnyAction", where, () =>
              def.test.randomAnyAction(state, viewer, rng),
            ),
          ),
        ];
        for (const action of actions) {
          same("validate", (s) => def.validate(s, viewer, action, this.resources));
          if (def.preview !== undefined) {
            same("preview", (s) => def.preview?.(s, viewer, action, this.resources));
          }
        }
      }
      this.records(combo, state, perturbed, toAct, acted, who, rng, where);
    }
    for (const seat of toAct) this.choiceInRecords(def, state, seat, seats, rng, where);
  }

  /**
   * Counts a perturbation for the non-vacuity rule (02 §6.3): it counts if it changes what some
   * other viewer sees (their hand is part of what `viewer` can't see), and, for games whose
   * hidden information no viewer ever sees (e.g. only deck order), if it changes the state.
   */
  private tally(
    def: AnyGameDefinition,
    state: unknown,
    perturbed: unknown,
    viewer: Seat | null,
    seats: number,
    before: string,
    where: Where,
  ): void {
    this.samples += 1;
    if (canonical(perturbed) !== before) this.statePerturbed += 1;
    const others = viewers(seats).filter((other) => other !== viewer);
    const changed = others.some((other) => {
      const a = this.call("schema", "view", where, () => def.view(state, other));
      const b = this.call("schema", "view (perturbed)", where, () => def.view(perturbed, other));
      return !sameJson(a, b);
    });
    if (changed) this.viewPerturbed += 1;
  }

  /** Records by any seat must be the same on `s` and `s'`, and not depend on the draws (02 §6.3). */
  private records(
    combo: Combo,
    state: unknown,
    perturbed: unknown,
    toAct: readonly Seat[],
    acted: ReadonlySet<Seat>,
    who: string,
    rng: RandomSource,
    where: Where,
  ): void {
    const { def } = combo;
    const transitions: { what: string; run: (s: unknown, r: RandomSource) => unknown }[] = [];
    for (const seat of toAct) {
      const action = this.call("secrecy", "randomAction", where, () =>
        def.test.randomAction(state, seat, rng, this.resources),
      );
      const legalThere = this.call("secrecy", "validate (perturbed)", where, () =>
        def.validate(perturbed, seat, action, this.resources),
      );
      if (!isGameError(legalThere)) {
        transitions.push({
          what: `apply by seat ${String(seat)}`,
          run: (s, r) => def.apply(s, seat, action, r).record,
        });
      }
      if (acted.has(seat)) {
        transitions.push({
          what: `onTimeout of seat ${String(seat)}`,
          run: (s, r) => def.onTimeout(s, seat, r).record,
        });
      }
    }
    const playing = this.playing(def, state, where);
    const leaver = playing[rng.nextInt(Math.max(1, playing.length))];
    if (leaver !== undefined) {
      // As the framework would (02 §4): a seat that hasn't acted declines if enough would remain.
      const reason = !acted.has(leaver) && playing.length - 1 >= combo.min ? "decline" : "resign";
      transitions.push({
        what: `onResign(${reason}) of seat ${String(leaver)}`,
        run: (s, r) => def.onResign(s, leaver, r, reason).record,
      });
    }
    for (const { what, run } of transitions) {
      const recording = recordRandom(seededRandom(rng.nextInt(2 ** 32)));
      const record = this.call("secrecy", what, where, () => run(jsonClone(state), recording.rng));
      const fallback = seededRandom(rng.nextInt(2 ** 32));
      const there = this.call("secrecy", `${what} (perturbed)`, where, () =>
        run(jsonClone(perturbed), scriptedRandom(recording.draws, fallback)),
      );
      this.check(
        sameJson(record, there),
        "secrecy",
        `the record of ${what} depends on information hidden from ${who}`,
        where,
      );
      if (def.test.publicRandomness !== true && recording.draws.length > 0) {
        const other = this.call("secrecy", `${what} (other draws)`, where, () =>
          run(jsonClone(state), seededRandom(rng.nextInt(2 ** 32))),
        );
        this.check(
          sameJson(record, other),
          "secrecy",
          `the record of ${what} shows random draws (set publicRandomness if that is intended)`,
          where,
        );
      }
    }
  }

  /**
   * A record mustn't show a seat's own secret choice (02 §6.3): two legal actions by `seat` on the
   * same state that leave every other viewer's view identical must give the same record and
   * `describe` text.
   */
  private choiceInRecords(
    def: AnyGameDefinition,
    state: unknown,
    seat: Seat,
    seats: number,
    rng: RandomSource,
    where: Where,
  ): void {
    const pick = (): unknown =>
      this.call("secrecy", "randomAction", where, () =>
        def.test.randomAction(state, seat, rng, this.resources),
      );
    const first = pick();
    let second: unknown = first;
    for (let i = 0; i < OTHER_ACTION_TRIES && sameJson(first, second); i += 1) second = pick();
    if (sameJson(first, second)) return;
    const draws = recordRandom(seededRandom(rng.nextInt(2 ** 32)));
    const fallback = seededRandom(rng.nextInt(2 ** 32));
    const a = this.call("schema", "apply", where, () =>
      def.apply(jsonClone(state), seat, first, draws.rng),
    );
    const b = this.call("schema", "apply", where, () =>
      def.apply(jsonClone(state), seat, second, scriptedRandom(draws.draws, fallback)),
    );
    const others = viewers(seats).filter((other) => other !== seat);
    const lookSame = others.every((other) =>
      sameJson(
        this.call("schema", "view", where, () => def.view(a.state, other)),
        this.call("schema", "view", where, () => def.view(b.state, other)),
      ),
    );
    if (!lookSame) return;
    const textA = this.call("schema", "describe", where, () => def.describe(a.record));
    const textB = this.call("schema", "describe", where, () => def.describe(b.record));
    this.check(
      sameJson(a.record, b.record) && sameJson(textA, textB),
      "secrecy",
      `the record of an action by seat ${String(seat)} shows a choice no other seat can see: two actions that look the same to everyone else give different records`,
      where,
    );
  }

  /** Whether the perturbation samples were vacuous (02 §6.3). */
  vacuity(def: AnyGameDefinition): void {
    const { samples, viewPerturbed, statePerturbed } = this;
    this.samples = 0;
    this.viewPerturbed = 0;
    this.statePerturbed = 0;
    if (!def.test.hiddenInformation || samples === 0) return;
    // Views count when any viewer ever sees hidden information; otherwise only the state can.
    const [counted, what] =
      viewPerturbed > 0 ? [viewPerturbed, "another viewer's view"] : [statePerturbed, "the state"];
    if (counted * 2 < samples) {
      this.fail(
        "secrecy",
        `perturbHidden changed ${what} in only ${String(counted)} of ${String(samples)} samples taken in progress; it must change at least half`,
        { version: def.version },
      );
    }
  }

  // --- replay (02 §5, §6.2) ------------------------------------------------------------------

  private replay(
    def: AnyGameDefinition,
    options: unknown,
    seats: number,
    setupDraws: readonly number[],
    log: readonly LogEntry[],
    expected: unknown,
    where: Where,
  ): void {
    const none: Resources = {};
    const draws = replayRandom(setupDraws);
    // Replay happens with an empty resource provider (02 §2.1 rule 6): the module sees one before
    // anything else, as a fresh server would after a resource is purged.
    const first = log.find((entry) => entry.kind === "action");
    let state: unknown = this.call("replay", "replay setup", where, () => {
      const initial = def.setup({ options, seats, rng: seededRandom(0) });
      if (first !== undefined) def.validate(initial, first.seat, first.action, none);
      return def.setup({ options, seats, rng: draws });
    });
    this.check(
      draws.remaining() === 0,
      "replay",
      "setup didn't use the same random draws on replay",
      where,
    );
    for (const [index, entry] of log.entries()) {
      const rng = replayRandom(entry.draws);
      state = this.call("replay", `replay of transition ${String(index)}`, where, () => {
        const current = jsonClone(state);
        switch (entry.kind) {
          case "action":
            def.validate(current, entry.seat, entry.action, none);
            return def.apply(current, entry.seat, entry.action, rng).state;
          case "timeout":
            return def.onTimeout(current, entry.seat, rng).state;
          default:
            return def.onResign(current, entry.seat, rng, entry.kind).state;
        }
      });
      this.check(
        rng.remaining() === 0,
        "replay",
        `transition ${String(index)} used different draws on replay`,
        where,
      );
    }
    this.check(
      sameJson(state, expected),
      "replay",
      "replaying the log doesn't reproduce the state",
      where,
    );
  }

  // --- isolation (02 §6.7) -------------------------------------------------------------------

  isolation(combo: Combo, seedA: number, seedB: number): void {
    const where = { version: combo.def.version, seats: combo.seats, seed: seedA };
    const plan: GamePlan = { exits: true, everyStep: false };
    const run = (seeds: readonly number[]): Observation[][] => {
      const seen = seeds.map((): Observation[] => []);
      const games = seeds.map((seed, index) =>
        this.game(combo, seed, plan, (o) => seen[index]?.push(o)),
      );
      const tallies = [this.samples, this.viewPerturbed, this.statePerturbed] as const;
      this.quietly(() => {
        let live = games.length;
        while (live > 0) {
          live = 0;
          for (const game of games) {
            try {
              if (game.next().done !== true) live += 1;
            } catch {
              // The game stopped on a failure, which playing it on its own reported.
            }
          }
        }
      });
      [this.samples, this.viewPerturbed, this.statePerturbed] = tallies;
      return seen;
    };
    const alone = [...run([seedA]), ...run([seedB])];
    const together = run([seedA, seedB]);
    if (!sameJson(alone, together)) {
      this.fail(
        "isolation",
        `games ${String(seedA)} and ${String(seedB)} see different results when played interleaved through the same engine than when played alone`,
        where,
      );
    }
  }
}

/**
 * Runs the generic test kit (02 §6) over every rules version a package exports. Fast mode plays
 * 300 games per rules version, spread over its option sets and seat counts; full mode plays 1000
 * per option set and seat count, a tenth of them with secrecy checked at every step. Half the
 * games have no seat leaving, so long games run to their end (02 §6.4).
 *
 * @public
 */
export function runKit(engines: GameEngines, options: KitOptions): KitReport {
  const kit = new Kit(options);
  if (options.manifest !== undefined) {
    for (const message of checkManifest(options.manifest, engines, options)) {
      kit.fail("manifest", message);
    }
  }
  let seed = options.seed ?? 1;
  const stop = (): boolean => options.stopAtFirstFailure === true && kit.failures.length > 0;
  for (const def of Object.values(engines)) {
    const combos = resolveCombos(kit, def, options);
    const perCombo =
      options.games ??
      (options.mode === "full"
        ? FULL_GAMES
        : Math.max(3, Math.ceil(FAST_GAMES / Math.max(1, combos.length))));
    for (const combo of combos) {
      for (let game = 0; game < perCombo && !stop(); game += 1) {
        seed += 1;
        kit.games += 1;
        kit.play(combo, seed, {
          // Half the games run without exits, so long games reach their end (02 §6.4).
          exits: game % 2 === 1,
          everyStep: options.mode === "full" && EVERY_STEP_SLOTS.has(game % EVERY_STEP_PERIOD),
        });
      }
      if (stop()) break;
      checkCpu(kit, combo, seed, options);
      const pairs = options.mode === "full" ? 20 : 3;
      for (let pair = 0; pair < pairs && !stop(); pair += 1) {
        seed += 2;
        kit.isolation(combo, seed - 1, seed);
      }
    }
    kit.vacuity(def);
    if (stop()) break;
  }
  return { failures: kit.failures, games: kit.games };
}

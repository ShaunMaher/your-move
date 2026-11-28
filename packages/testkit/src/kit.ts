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

import { environmentCpuBudget, readCpuBudget } from "./budget.js";
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
import type { KitOptions, KitReport, KitShard } from "./types.js";

export type { KitFailure, KitMode, KitOptions, KitProperty, KitReport, KitShard } from "./types.js";

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
/**
 * Legal actions drawn per seat and secrecy sample for the secret-choice record check (02 §6.3): with
 * `randomAction` producing every action kind at least a tenth of the time, two of a rare kind are
 * often among them.
 */
const CHOICE_ACTIONS = 8;
/** The largest `maxActions` the kit accepts: beyond it, random play can't show termination. */
const MAX_ACTIONS_CAP = 1_000_000;
/**
 * Seeds per combination. The `k`-th combination a run plays (counting every rules version's, in
 * order) takes its seeds from `seed + k * SEED_STRIDE` on: its games first, then its isolation
 * pairs, then its CPU check. A combination's seeds depend only on its number, so a shard
 * (`KitOptions.shard`) plays each of its combinations exactly as the whole run does.
 */
const SEED_STRIDE = 2 ** 20;
/** Seeds must stay below this: `seededRandom` takes a 32-bit seed. */
const SEED_LIMIT = 2 ** 32;
/** Isolation pairs per combination (02 §6.7). */
const ISOLATION_PAIRS = { fast: 3, full: 20 } as const;

/** What a client receives for an output whose JSON is `json` (see `canonical`). */
const served = (json: string): unknown =>
  json === "undefined" ? undefined : (JSON.parse(json) as unknown);

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
  /** Each viewer's view of `state` as JSON (each seat, then the public), as served at that step. */
  readonly views: readonly string[];
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
  /** Combinations played (in this shard). */
  combos = 0;
  /**
   * Secrecy samples taken while a game of the current combination was in progress; how many
   * changed some other viewer's view; how many changed the state at all (02 §6.3 non-vacuity).
   */
  private samples = 0;
  private viewPerturbed = 0;
  private statePerturbed = 0;
  /** The resources of the combo being played (`test.resources`). */
  private resources: Resources = {};
  /**
   * The rules version's `test.hiddenFromEveryone` and `test.hiddenInformation`, read once when
   * `runKit` starts on that version (see {@link Kit.claims}), so a hook that changed its answer
   * can't dodge the checks.
   */
  private sameView = false;
  private hidden = false;

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
      const seen = this.observeViews(def, state, seats, where, observe);
      const finished = this.call("schema", "result", where, () => def.result(state)) !== null;
      if (finished) break;
      this.sameForEveryone(seen, toAct, where);
      if (step >= limit) {
        this.fail(
          "termination",
          `no result after maxActions (${String(limit)}) transitions`,
          where,
        );
        throw new GameAborted();
      }
      // A copy of this point, made only when it is checked: the module may change `state` later.
      const sample = (): Sample => ({
        state: jsonClone(state),
        toAct,
        acted: [...acted],
        views: seen.map((viewer) => viewer.view),
      });
      if (plan.everyStep) {
        this.secrecy(combo, sample(), sampler, where);
      } else if (reservoir.length < size) {
        // Reservoir sampling: every in-progress step is equally likely to be checked, early or
        // late (02 §6.3).
        reservoir.push(sample());
      } else {
        const slot = sampler.nextInt(step + 1);
        if (slot < size) reservoir[slot] = sample();
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

  /**
   * Checks every viewer's view and summary against their schemas; returns their JSON, by viewer
   * (each seat, then the public). What is checked is the JSON the framework serves, parsed again,
   * not the value the module returned: a `NaN` is served as `null`, an `undefined` property not at
   * all and a `Date` as its ISO string, so the value could pass a schema the served data fails, or
   * the other way round. Each distinct JSON is therefore checked once per step, which gives exactly
   * the answer checking it once per viewer would (every viewer of a `hiddenFromEveryone` game gets
   * the same one).
   */
  private observeViews(
    def: AnyGameDefinition,
    state: unknown,
    seats: number,
    where: Where,
    observe?: (o: Observation) => void,
  ): { view: string; summary: string }[] {
    const views = new Set<string>();
    const summaries = new Set<string>();
    return viewers(seats).map((viewer) => {
      const view = this.call("schema", "view", where, () => def.view(state, viewer));
      const viewJson = canonical(view);
      if (!views.has(viewJson)) {
        this.check(
          def.viewSchema.safeParse(served(viewJson)).success,
          "schema",
          `view for ${String(viewer)} doesn't match viewSchema`,
          where,
        );
        views.add(viewJson);
      }
      const summary = this.call("schema", "summary", where, () => def.summary(state, viewer));
      const summaryJson = canonical(summary);
      if (!summaries.has(summaryJson)) {
        this.check(
          listSummarySchema.safeParse(served(summaryJson)).success,
          "schema",
          `summary for ${String(viewer)} isn't a ListSummary`,
          where,
        );
        summaries.add(summaryJson);
      }
      observe?.(`view ${String(viewer)} ${viewJson} ${summaryJson}`);
      return { view: viewJson, summary: summaryJson };
    });
  }

  /**
   * Reads a rules version's `hiddenFromEveryone` and `hiddenInformation` once, before any game of
   * it is played; the first requires the second (02 §6.3).
   */
  claims(def: AnyGameDefinition): void {
    this.sameView = def.test.hiddenFromEveryone === true;
    this.hidden = def.test.hiddenInformation;
    if (this.sameView && !this.hidden) {
      this.fail("secrecy", "hiddenFromEveryone is set but hiddenInformation isn't", {
        version: def.version,
      });
    }
  }

  /**
   * A module that sets `hiddenFromEveryone` gives every seat and the public the same view while the
   * game is in progress (identical JSON, key order included), and every seat not in `toAct` the
   * same summary as the public, at every step (02 §6.3). Only the seats to act may be told
   * something else ("your turn").
   */
  private sameForEveryone(
    seen: readonly { view: string; summary: string }[],
    toAct: readonly Seat[],
    where: Where,
  ): void {
    if (!this.sameView) return;
    const publicIndex = seen.length - 1;
    const who = (index: number): string =>
      index === publicIndex ? "the public" : `seat ${String(index)}`;
    const differs = seen.findIndex((viewer) => viewer.view !== seen[0]?.view);
    this.check(
      differs < 0,
      "secrecy",
      `hiddenFromEveryone is set, but ${who(differs)} gets a different view from seat 0 while the game is in progress`,
      where,
    );
    const told = seen.findIndex(
      (viewer, seat) =>
        seat !== publicIndex &&
        !toAct.includes(seat) &&
        viewer.summary !== seen[publicIndex]?.summary,
    );
    this.check(
      told < 0,
      "secrecy",
      `hiddenFromEveryone is set, but seat ${String(told)}, which isn't to act, gets a different summary from the public while the game is in progress`,
      where,
    );
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
      this.tally(def, sample, perturbed, viewer, seats, before, where);
      const who = viewer === null ? "the public" : `seat ${String(viewer)}`;
      const hidden = (what: string): string =>
        `${what} for ${who} depends on information hidden from ${who}`;
      const same = (what: string, fn: (s: unknown) => unknown): void => {
        // An exception is a bug whatever the state (02 §2.1 rule 3), so it counts as schema.
        const a = this.call("schema", what, where, () => fn(state));
        const b = this.call("schema", `${what} (perturbed)`, where, () => fn(perturbed));
        this.check(sameJson(a, b), "secrecy", hidden(what), where);
      };
      // The view of `state` is the JSON this viewer was served at that step.
      const view = this.call("schema", "view (perturbed)", where, () =>
        def.view(perturbed, viewer),
      );
      const shown = sample.views[viewer ?? seats];
      this.check(canonical(view) === shown, "secrecy", hidden("view"), where);
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
    sample: Sample,
    perturbed: unknown,
    viewer: Seat | null,
    seats: number,
    before: string,
    where: Where,
  ): void {
    this.samples += 1;
    if (canonical(perturbed) !== before) this.statePerturbed += 1;
    // A module that sets hiddenFromEveryone is counted by the state alone (see `vacuity`).
    if (this.sameView) return;
    // Each other viewer's view of the sample is the JSON they were served at that step.
    const changed = viewers(seats).some((other, index) => {
      if (other === viewer) return false;
      const b = this.call("schema", "view (perturbed)", where, () => def.view(perturbed, other));
      return canonical(b) !== sample.views[index];
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
   * A record mustn't show a seat's own secret choice (02 §6.3): several legal actions by `seat` on
   * the same state, applied with the same draws, are grouped by every other viewer's view after
   * them; within a group the records and `describe` text must be identical.
   */
  private choiceInRecords(
    def: AnyGameDefinition,
    state: unknown,
    seat: Seat,
    seats: number,
    rng: RandomSource,
    where: Where,
  ): void {
    const actions = new Map<string, unknown>();
    for (let i = 0; i < CHOICE_ACTIONS; i += 1) {
      const action = this.call("secrecy", "randomAction", where, () =>
        def.test.randomAction(state, seat, rng, this.resources),
      );
      actions.set(canonical(action), action);
    }
    if (actions.size < 2) return;
    const draws = recordRandom(seededRandom(rng.nextInt(2 ** 32)));
    const fallback = seededRandom(rng.nextInt(2 ** 32));
    const others = viewers(seats).filter((other) => other !== seat);
    /** Other viewers' views after the action → the first record and text seen with them. */
    const groups = new Map<string, string>();
    // The first action records its draws; the others replay them.
    for (const [index, action] of [...actions.values()].entries()) {
      const random = index === 0 ? draws.rng : scriptedRandom(draws.draws, fallback);
      const after = this.call("schema", "apply", where, () =>
        def.apply(jsonClone(state), seat, action, random),
      );
      const seen = canonical(
        others.map((other) =>
          this.call("schema", "view", where, () => def.view(after.state, other)),
        ),
      );
      const text = this.call("schema", "describe", where, () => def.describe(after.record));
      const told = `${canonical(after.record)} ${canonical(text)}`;
      const earlier = groups.get(seen);
      if (earlier === undefined) groups.set(seen, told);
      this.check(
        earlier === undefined || earlier === told,
        "secrecy",
        `the record of an action by seat ${String(seat)} shows a choice no other seat can see: two actions that look the same to everyone else give different records`,
        where,
      );
    }
  }

  /**
   * Whether the perturbation samples since the last call were vacuous (02 §6.3): those of one
   * combination's games in full mode, of the whole rules version's in fast mode (see `runKit`).
   */
  vacuity(def: AnyGameDefinition, combo?: Combo): void {
    const { samples, viewPerturbed, statePerturbed } = this;
    this.samples = 0;
    this.viewPerturbed = 0;
    this.statePerturbed = 0;
    if (!this.hidden || samples === 0) return;
    // A perturbation counts when it changes what another viewer sees. Only a module that declares
    // its hidden information is seen by no seat at all (e.g. deck order alone) is counted by
    // whether the state changed: otherwise reordering a deck while hands leak would pass.
    const [counted, what] = this.sameView
      ? [statePerturbed, "the state"]
      : [viewPerturbed, "another viewer's view"];
    if (counted * 2 < samples) {
      this.fail(
        "secrecy",
        `perturbHidden changed ${what} in only ${String(counted)} of ${String(samples)} samples taken in progress${combo === undefined ? "" : ` under options ${canonical(combo.options)}`}; it must change at least half`,
        combo === undefined
          ? { version: def.version }
          : { version: def.version, seats: combo.seats },
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
    const same = (a: readonly Observation[], b: readonly Observation[] | undefined): boolean =>
      a.length === b?.length && a.every((observation, i) => observation === b[i]);
    if (alone.length !== together.length || !alone.every((seen, i) => same(seen, together[i]))) {
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
 * Non-vacuity (02 §6.3) is judged per option set and seat count in full mode, and per rules
 * version in fast mode, where a combination may have only three games. So a full-mode run can be
 * sharded (`shard`): each combination is played, with the seeds of its number, and judged exactly
 * as in the whole run.
 *
 * The CPU budget is the `cpuBudgetMs` option, else the host's `KIT_CPU_BUDGET_MS` (set in CI to
 * its calibrated value), else the reference 5 ms (./budget.ts).
 *
 * @public
 */
export function runKit(engines: GameEngines, given: KitOptions): KitReport {
  const fromEnvironment =
    given.cpuBudgetMs === undefined ? readCpuBudget(undefined, environmentCpuBudget()) : undefined;
  const options: KitOptions =
    fromEnvironment?.ok === true && fromEnvironment.ms !== undefined
      ? { ...given, cpuBudgetMs: fromEnvironment.ms }
      : given;
  const shard = options.shard ?? { index: 1, count: 1 };
  if (!isShard(shard)) {
    throw new RangeError(
      `shard must be index/count with 1 <= index <= count; it is ${String(shard.index)}/${String(shard.count)}`,
    );
  }
  // Fast mode judges non-vacuity over a whole rules version, which a shard doesn't play.
  if (options.mode === "fast" && shard.count > 1) {
    throw new RangeError("only a full-mode run can be sharded");
  }
  const pairs = ISOLATION_PAIRS[options.mode];
  // A combination's games, isolation pairs and CPU check each take seeds from its stride.
  const maxGames = SEED_STRIDE - 2 * pairs - 1;
  if (options.games !== undefined && options.games > maxGames) {
    throw new RangeError(`games must be at most ${String(maxGames)}`);
  }
  const kit = new Kit(options);
  if (fromEnvironment?.ok === false) kit.fail("cpu", fromEnvironment.problem);
  if (options.manifest !== undefined) {
    for (const message of checkManifest(options.manifest, engines, options)) {
      kit.fail("manifest", message);
    }
  }
  const base = options.seed ?? 1;
  const stop = (): boolean => options.stopAtFirstFailure === true && kit.failures.length > 0;
  // Every combination of every rules version is numbered in order, whichever shard plays it.
  let comboNumber = -1;
  /** Every combination of the run, in order, whichever shard plays it: see `KitReport.allCombos`. */
  const list: string[] = [];
  for (const def of Object.values(engines)) {
    kit.claims(def);
    const combos = resolveCombos(kit, def, options);
    // Fast mode spreads its games over all of the version's combinations, played or not.
    const perCombo =
      options.games ??
      (options.mode === "full"
        ? FULL_GAMES
        : Math.max(3, Math.ceil(FAST_GAMES / Math.max(1, combos.length))));
    for (const combo of combos) {
      comboNumber += 1;
      const first = base + comboNumber * SEED_STRIDE;
      if (first + SEED_STRIDE > SEED_LIMIT) {
        // Seeds are 32-bit (./random.ts): past this, a combination would replay another's games.
        kit.fail(
          "schema",
          `the kit plays at most ${String(Math.floor((SEED_LIMIT - base) / SEED_STRIDE))} option set and seat count combinations from seed ${String(base)}; this module has more`,
          { version: def.version },
        );
        break;
      }
      list.push(`${String(def.version)} ${canonical(combo.options)} ${String(combo.seats)}`);
      if (comboNumber % shard.count !== shard.index - 1 || stop()) continue;
      kit.combos += 1;
      for (let game = 0; game < perCombo && !stop(); game += 1) {
        kit.games += 1;
        kit.play(combo, first + game, {
          // Half the games run without exits, so long games reach their end (02 §6.4).
          exits: game % 2 === 1,
          everyStep: options.mode === "full" && EVERY_STEP_SLOTS.has(game % EVERY_STEP_PERIOD),
        });
      }
      if (options.mode === "full") kit.vacuity(def, combo);
      if (stop()) continue;
      checkCpu(kit, combo, first + perCombo + 2 * pairs, options);
      for (let pair = 0; pair < pairs && !stop(); pair += 1) {
        const seed = first + perCombo + 2 * pair;
        kit.isolation(combo, seed, seed + 1);
      }
    }
    if (options.mode === "fast") kit.vacuity(def);
    if (stop()) break;
  }
  return {
    failures: kit.failures,
    games: kit.games,
    combos: kit.combos,
    allCombos: list.length,
    comboDigest: digest(list.join("\n")),
  };
}

/**
 * A short fingerprint of `text` (FNV-1a, 64 bits, over its UTF-16 code units, as 16 hex digits),
 * for comparing the logs of a run's shards; not a cryptographic hash.
 */
function digest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Whether `shard` names one of `count` shards, numbered from 1. */
function isShard(shard: KitShard): boolean {
  return (
    Number.isSafeInteger(shard.index) &&
    Number.isSafeInteger(shard.count) &&
    shard.index >= 1 &&
    shard.index <= shard.count
  );
}

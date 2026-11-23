/**
 * The generic test kit (docs/spec/02-game-framework.md §6): plays many seeded random games through
 * every exported rules version of a game engine and checks the contract rules of 02 §2.1 that can
 * be checked from outside the module. Every failure names its property and, where it came from a
 * game, the seed that reproduces it.
 */
import {
  RESERVED_ERROR_CODES,
  isGameError,
  listSummarySchema,
  recordRandom,
  replayRandom,
  textSchema,
  type AnyGameDefinition,
  type GameEngines,
  type GameManifest,
  type OptionsContext,
  type RandomSource,
  type Resources,
  type Seat,
} from "@your-move/sdk";

import { canonical, isPlainJson, sameJson } from "./canonical.js";
import { checkManifest } from "./manifest.js";
import { scriptedRandom, seededRandom } from "./random.js";

/**
 * `fast`: a few hundred games per package (`pnpm games:verify --fast`); `full`: a thousand games per
 * option set and seat count (CI's test stage and each game package's own CI), 02 §6.
 *
 * @public
 */
export type KitMode = "fast" | "full";

/**
 * The kit's checks (02 §6), plus the manifest check of 02 §7.2.
 *
 * @public
 */
export type KitProperty =
  "schema" | "replay" | "secrecy" | "termination" | "turns" | "cpu" | "isolation" | "manifest";

/**
 * One failed check.
 *
 * @public
 */
export interface KitFailure {
  readonly property: KitProperty;
  readonly message: string;
  /** The rules version it failed on. */
  readonly version?: number;
  /** The seat count of the failing game. */
  readonly seats?: number;
  /** The seed that reproduces the failing game. */
  readonly seed?: number;
}

/**
 * How to run the kit.
 *
 * @public
 */
export interface KitOptions {
  readonly mode: KitMode;
  /** The package's manifest: when given, it must agree with every engine (02 §7.2). */
  readonly manifest?: GameManifest;
  /** Option inputs to resolve and play, each with every allowed seat count. Default `[{}]`. */
  readonly optionInputs?: readonly unknown[];
  /** What `resolveOptions` and `catalog` see. Default: `configSchema` parsed from `{}`, no resources. */
  readonly context?: OptionsContext;
  /** Resources passed to `validate` and `preview` while playing (replay always uses none). */
  readonly resources?: Resources;
  /** The first seed; game `n` uses `seed + n`. Default 1. */
  readonly seed?: number;
  /** Games per option set and seat count, overriding the mode's number. */
  readonly games?: number;
  /** Per-call CPU budget in milliseconds for `worstCase` inputs (08 T25). Default 5. */
  readonly cpuBudgetMs?: number;
}

/**
 * What the kit found.
 *
 * @public
 */
export interface KitReport {
  readonly failures: readonly KitFailure[];
  /** How many games were played. */
  readonly games: number;
}

/** At most this many failures are kept per property; the rest add nothing. */
const MAX_FAILURES_PER_PROPERTY = 5;
/** Games per package in fast mode, spread over the option sets and seat counts. */
const FAST_GAMES = 300;
const FULL_GAMES = 1000;
/** Chance per step that a seat leaves (resign, decline or timeout) instead of acting. */
const EXIT_CHANCE = 40;
/** Possibly-illegal actions tried per step and per secrecy sample. */
const ANY_ACTIONS = 2;

/** Ends the current game after its first failure. */
class GameAborted extends Error {}

interface Combo {
  readonly def: AnyGameDefinition;
  readonly options: unknown;
  readonly seats: number;
}

interface LogEntry {
  readonly kind: "action" | "resign" | "decline" | "timeout";
  readonly seat: Seat;
  readonly action?: unknown;
  readonly draws: readonly number[];
}

/** What a game looked like from outside at one point: used by the isolation check. */
type Observation = string;

class Kit {
  readonly failures: KitFailure[] = [];
  private readonly counts = new Map<KitProperty, number>();
  games = 0;
  /** Secrecy samples taken while a game was in progress, and how many perturbed something. */
  private samples = 0;
  private perturbed = 0;

  readonly options: KitOptions;
  readonly resources: Resources;

  constructor(options: KitOptions, resources: Resources) {
    this.options = options;
    this.resources = resources;
  }

  fail(property: KitProperty, message: string, where: Partial<KitFailure> = {}): void {
    const count = this.counts.get(property) ?? 0;
    this.counts.set(property, count + 1);
    if (count < MAX_FAILURES_PER_PROPERTY) this.failures.push({ property, message, ...where });
  }

  /** Calls into the module; an exception is a failure of `property` (exceptions are bugs, 02 §2.1). */
  call<T>(property: KitProperty, what: string, where: Partial<KitFailure>, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      this.fail(property, `${what} threw ${errorName(error)}`, where);
      throw new GameAborted();
    }
  }

  check(ok: boolean, property: KitProperty, message: string, where: Partial<KitFailure>): void {
    if (!ok) {
      this.fail(property, message, where);
      throw new GameAborted();
    }
  }

  // --- static checks (02 §6.1) ---------------------------------------------------------------

  /** Resolves the option inputs and checks the module's schemas and codes; returns what to play. */
  combos(def: AnyGameDefinition): Combo[] {
    const where = { version: def.version };
    const reserved = def.errorCodes.filter((code) => RESERVED_ERROR_CODES.includes(code));
    if (reserved.length > 0) {
      this.fail(
        "schema",
        `errorCodes contains reserved codes: ${reserved.join(", ")} (02 §2.2)`,
        where,
      );
    }
    const ctx = this.context(def);
    if (ctx === null) return [];
    try {
      this.gameErrorOrOk(def, def.checkConfig(ctx.config, ctx.resources), "checkConfig", where);
      const catalog = def.catalog(ctx);
      if (!def.catalogSchema.safeParse(catalog).success) {
        this.fail("schema", "catalog() doesn't match catalogSchema", where);
      }
      for (const garbage of [null, 42, "x", [1], { unknownOption: true }]) {
        const resolved = def.resolveOptions(garbage, ctx);
        if (isGameError(resolved)) this.errorCode(def, resolved.code, "resolveOptions", where);
        else if (!def.optionsSchema.safeParse(resolved).success) {
          this.fail(
            "schema",
            "resolveOptions returned options that don't match optionsSchema",
            where,
          );
        }
      }
    } catch (error) {
      this.fail("schema", `option resolution threw ${errorName(error)}`, where);
      return [];
    }

    const combos: Combo[] = [];
    for (const input of this.options.optionInputs ?? [{}]) {
      let options: unknown;
      try {
        options = def.resolveOptions(input, ctx);
      } catch (error) {
        this.fail("schema", `resolveOptions threw ${errorName(error)}`, where);
        continue;
      }
      if (isGameError(options)) {
        this.fail(
          "schema",
          `resolveOptions refused option input ${canonical(input)}: ${options.code}`,
          where,
        );
        continue;
      }
      if (!def.optionsSchema.safeParse(options).success) {
        this.fail("schema", "resolved options don't match optionsSchema", where);
        continue;
      }
      try {
        const { min, max } = def.players(options);
        const timeout = def.defaultTurnTimeoutDays(options);
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30) {
          this.fail(
            "schema",
            "defaultTurnTimeoutDays must be a whole number of days from 1 to 30",
            where,
          );
        }
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || min > max) {
          this.fail(
            "schema",
            `players() returned an invalid range ${String(min)}–${String(max)}`,
            where,
          );
          continue;
        }
        let playable = 0;
        for (let seats = min; seats <= max; seats += 1) {
          const start = def.validateStart(options, seats);
          if (isGameError(start)) {
            this.errorCode(def, start.code, "validateStart", where);
          } else {
            playable += 1;
            combos.push({ def, options, seats });
          }
        }
        if (playable === 0) {
          this.fail(
            "schema",
            `validateStart refuses every seat count for ${canonical(input)}`,
            where,
          );
        }
      } catch (error) {
        this.fail("schema", `players/validateStart threw ${errorName(error)}`, where);
      }
    }
    return combos;
  }

  private context(def: AnyGameDefinition): OptionsContext | null {
    if (this.options.context !== undefined) return this.options.context;
    const config = def.configSchema.safeParse({});
    if (!config.success) {
      this.fail("schema", "configSchema doesn't accept an empty configuration; pass context", {
        version: def.version,
      });
      return null;
    }
    return { config: config.data, resources: [] };
  }

  private gameErrorOrOk(
    def: AnyGameDefinition,
    value: unknown,
    what: string,
    where: Partial<KitFailure>,
  ): void {
    if (isGameError(value)) this.errorCode(def, value.code, what, where);
    else if (!sameJson(value, { ok: true }))
      this.fail("schema", `${what} must return OK or a GameError`, where);
  }

  private errorCode(
    def: AnyGameDefinition,
    code: string,
    what: string,
    where: Partial<KitFailure>,
  ): void {
    if (!def.errorCodes.includes(code)) {
      this.fail("schema", `${what} returned code ${code}, which isn't in errorCodes`, where);
    }
  }

  // --- one game ------------------------------------------------------------------------------

  /** Plays one seeded game with every per-step check. */
  play(combo: Combo, seed: number): void {
    const steps = this.game(combo, seed);
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
    observe?: (observation: Observation) => void,
  ): Generator<void, void> {
    const { def, options, seats } = combo;
    const where = { version: def.version, seats, seed };
    const rng = seededRandom(seed);
    const recording = recordRandom(seededRandom(seed ^ 0x5bd1e995));
    let state: unknown = this.call("replay", "setup", where, () =>
      def.setup({ options, seats, rng: recording.rng }),
    );
    state = this.roundTrip(state, "setup", where);
    const setupDraws = [...recording.draws];
    const log: LogEntry[] = [];
    const acted = new Set<Seat>();
    const out = new Set<Seat>();
    const limit = this.call("termination", "maxActions", where, () =>
      def.test.maxActions(options, seats),
    );
    let secrecyBudget = this.options.mode === "full" ? 3 : 1;

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
      if (secrecyBudget > 0 && rng.nextInt(4) === 0) {
        secrecyBudget -= 1;
        this.secrecy(def, state, seats, toAct, acted, rng, where);
      }

      const playing = this.playing(def, state, where);
      const entry = this.transition(def, state, toAct, playing, acted, rng, where, observe);
      const result = this.call("replay", entry.kind, where, entry.run);
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
  }

  /** Chooses and prepares the next transition: usually an action, sometimes a seat leaving. */
  private transition(
    def: AnyGameDefinition,
    state: unknown,
    toAct: readonly Seat[],
    playing: readonly Seat[],
    acted: ReadonlySet<Seat>,
    rng: RandomSource,
    where: Partial<KitFailure>,
    observe?: (observation: Observation) => void,
  ): {
    log: Omit<LogEntry, "draws">;
    run: () => { state: unknown; record: unknown };
    draws: () => readonly number[];
    kind: string;
  } {
    const recording = recordRandom(seededRandom(rng.nextInt(2 ** 32)));
    const leaver = playing[rng.nextInt(Math.max(1, playing.length))];
    if (leaver !== undefined && rng.nextInt(EXIT_CHANCE) === 0) {
      if (!acted.has(leaver)) {
        return {
          kind: "onResign(decline)",
          log: { kind: "decline", seat: leaver },
          run: () => def.onResign(state, leaver, recording.rng, "decline"),
          draws: () => recording.draws,
        };
      }
      if (toAct.includes(leaver) && rng.nextInt(2) === 0) {
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
    where: Partial<KitFailure>,
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
    where: Partial<KitFailure>,
    res = this.resources,
  ): unknown {
    const verdict = this.call("schema", "validate", where, () =>
      def.validate(state, seat, action, res),
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
    where: Partial<KitFailure>,
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
    where: Partial<KitFailure>,
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
  private roundTrip(state: unknown, after: string, where: Partial<KitFailure>): unknown {
    this.check(
      isPlainJson(state),
      "schema",
      `the state after ${after} isn't plain JSON data`,
      where,
    );
    return jsonClone(state);
  }

  // --- turn sanity (02 §6.5) -----------------------------------------------------------------

  private playing(def: AnyGameDefinition, state: unknown, where: Partial<KitFailure>): Seat[] {
    const status = this.call("turns", "seatStatus", where, () => def.seatStatus(state));
    return status.flatMap((value, seat) => (value === "playing" ? [seat] : []));
  }

  private turns(
    def: AnyGameDefinition,
    state: unknown,
    seats: number,
    out: Set<Seat>,
    where: Partial<KitFailure>,
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
    where: Partial<KitFailure>,
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
    where: Partial<KitFailure>,
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

  private secrecy(
    def: AnyGameDefinition,
    state: unknown,
    seats: number,
    toAct: readonly Seat[],
    acted: ReadonlySet<Seat>,
    rng: RandomSource,
    where: Partial<KitFailure>,
  ): void {
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
      this.samples += 1;
      if (canonical(perturbed) !== before) this.perturbed += 1;
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
      this.records(def, state, perturbed, toAct, acted, who, rng, where);
    }
  }

  /** Records by any seat must be the same on `s` and `s'`, and not depend on the draws (02 §6.3). */
  private records(
    def: AnyGameDefinition,
    state: unknown,
    perturbed: unknown,
    toAct: readonly Seat[],
    acted: ReadonlySet<Seat>,
    who: string,
    rng: RandomSource,
    where: Partial<KitFailure>,
  ): void {
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
      const reason = acted.has(leaver) ? "resign" : "decline";
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

  /** Whether the perturbation samples were vacuous (02 §6.3). */
  vacuity(def: AnyGameDefinition): void {
    if (def.test.hiddenInformation && this.samples > 0 && this.perturbed * 2 < this.samples) {
      this.fail(
        "secrecy",
        `perturbHidden changed the state in only ${String(this.perturbed)} of ${String(this.samples)} samples taken in progress; it must change at least half`,
        { version: def.version },
      );
    }
    this.samples = 0;
    this.perturbed = 0;
  }

  // --- replay (02 §5, §6.2) ------------------------------------------------------------------

  private replay(
    def: AnyGameDefinition,
    options: unknown,
    seats: number,
    setupDraws: readonly number[],
    log: readonly LogEntry[],
    expected: unknown,
    where: Partial<KitFailure>,
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
        const current = JSON.parse(JSON.stringify(state)) as unknown;
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

  // --- CPU budget (02 §6.6, 08 T25) ----------------------------------------------------------

  cpu(combo: Combo, seed: number): void {
    const { def, options, seats } = combo;
    const where = { version: def.version, seats, seed };
    const budget = this.options.cpuBudgetMs ?? 5;
    const runs = this.options.mode === "full" ? 100 : 20;
    let cases: readonly { state: unknown; seat: Seat; action: unknown }[];
    try {
      cases = def.test.worstCase(options, seats, seededRandom(seed));
    } catch (error) {
      this.fail("cpu", `worstCase threw ${errorName(error)}`, where);
      return;
    }
    for (const [index, { state, seat, action }] of cases.entries()) {
      const times: number[] = [];
      try {
        for (let run = 0; run < runs; run += 1) {
          const copy = jsonClone(state);
          const start = performance.now();
          const verdict = def.validate(copy, seat, action, this.resources);
          def.preview?.(copy, seat, action, this.resources);
          if (!isGameError(verdict)) def.apply(copy, seat, action, seededRandom(run));
          times.push(performance.now() - start);
        }
      } catch (error) {
        this.fail("cpu", `worstCase input ${String(index)} threw ${errorName(error)}`, where);
        continue;
      }
      // The 99th percentile: the slowest of the fastest 99 % of runs.
      const p99 = [...times]
        .sort((a, b) => a - b)
        .slice(0, Math.ceil(times.length * 0.99))
        .reduce((slowest, time) => Math.max(slowest, time), 0);
      if (p99 > budget) {
        this.fail(
          "cpu",
          `worstCase input ${String(index)} took ${p99.toFixed(2)} ms (p99), over the ${String(budget)} ms budget`,
          where,
        );
      }
    }
  }

  // --- isolation (02 §6.7) -------------------------------------------------------------------

  isolation(combo: Combo, seedA: number, seedB: number): void {
    const where = { version: combo.def.version, seats: combo.seats, seed: seedA };
    const run = (seeds: readonly number[]): Observation[][] => {
      const seen = seeds.map((): Observation[] => []);
      const games = seeds.map((seed, index) => this.game(combo, seed, (o) => seen[index]?.push(o)));
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

  /** Runs `fn` without recording failures: used to collect observations only. */
  private quietly(fn: () => void): void {
    const saved = [...this.failures];
    const savedCounts = new Map(this.counts);
    const savedSamples = [this.samples, this.perturbed];
    try {
      fn();
    } finally {
      this.failures.splice(0, this.failures.length, ...saved);
      this.counts.clear();
      for (const [key, value] of savedCounts) this.counts.set(key, value);
      [this.samples, this.perturbed] = savedSamples as [number, number];
    }
  }
}

/** States are JSON (02 §5), so a JSON copy is a full copy. */
const jsonClone = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

const viewers = (seats: number): (Seat | null)[] => [
  ...Array.from({ length: seats }, (_, seat) => seat),
  null,
];

function errorName(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Runs the generic test kit (02 §6) over every rules version a package exports.
 *
 * @public
 */
export function runKit(engines: GameEngines, options: KitOptions): KitReport {
  const kit = new Kit(options, options.resources ?? {});
  if (options.manifest !== undefined) {
    for (const message of checkManifest(
      options.manifest,
      engines,
      options.optionInputs ?? [{}],
      options.context,
    )) {
      kit.fail("manifest", message);
    }
  }
  const seed0 = options.seed ?? 1;
  let seed = seed0;
  for (const def of Object.values(engines)) {
    const combos = kit.combos(def);
    if (combos.length === 0) continue;
    const perCombo =
      options.games ??
      (options.mode === "full" ? FULL_GAMES : Math.max(3, Math.ceil(FAST_GAMES / combos.length)));
    for (const combo of combos) {
      for (let game = 0; game < perCombo; game += 1) {
        seed += 1;
        kit.games += 1;
        kit.play(combo, seed);
      }
      kit.cpu(combo, seed);
      const pairs = options.mode === "full" ? 20 : 3;
      for (let pair = 0; pair < pairs; pair += 1) {
        seed += 2;
        kit.isolation(combo, seed - 1, seed);
      }
    }
    kit.vacuity(def);
  }
  return { failures: kit.failures, games: kit.games };
}

import type { Resources } from "@your-move/sdk";
import { z } from "@your-move/sdk/schema";
import { describe, expect, it } from "vitest";

import { threadCpuClock } from "./cpu-clock.js";
import { runKit, type KitOptions } from "./kit.js";
import { asEngines, brokenFixtures, toyGame, toyManifest } from "./test-support.js";

/** A dictionary that knows every word: the "reads resources in setup" fixture needs one. */
const resources: Resources = { dictionary: { id: "all", version: 1, has: () => true } };
/** The CPU budget is timed in this thread's CPU time, as every Node caller of the kit does. */
const fast: KitOptions = {
  mode: "fast",
  resources,
  manifest: toyManifest,
  cpuClock: threadCpuClock().now,
  // The reference budget, named: CI sets KIT_CPU_BUDGET_MS, which a kit run reads when it is
  // given none (02 §6.6), and these tests are about the check, not the host.
  cpuBudgetMs: 5,
};

describe("runKit on a correct module", () => {
  it("passes in fast mode at every seat count", () => {
    const report = runKit(asEngines(toyGame()), fast);
    expect(report.failures).toEqual([]);
    expect(report.games).toBeGreaterThanOrEqual(300);
  });

  it("passes in full mode", () => {
    const report = runKit(asEngines(toyGame()), { ...fast, mode: "full", games: 50 });
    expect(report.failures).toEqual([]);
    // 50 games per option set (two) and seat count (two).
    expect(report.games).toBe(200);
  });
});

describe("runKit on the broken fixtures (02 §6)", () => {
  it.each(Object.entries(brokenFixtures()))("fails a module that %s", (_name, fixture) => {
    // Fast mode, stopping at the first failing game: a broken module must fail fast mode, and the
    // test stays cheap on a slow CI runner.
    const report = runKit(fixture.engines(), { ...fast, stopAtFirstFailure: true });
    const properties = report.failures.map((failure) => failure.property);
    expect(properties.some((property) => fixture.property.split("|").includes(property))).toBe(
      true,
    );
    for (const failure of report.failures.filter((f) => f.property !== "manifest")) {
      expect(failure.version).toBe(1);
    }
  });
});

describe("runKit without stopping at the first failure", () => {
  it("reports isolation on the module-level cache fixture", () => {
    const fixture =
      brokenFixtures()["keeps hidden state in a module-level cache shared between games"];
    const report = runKit(fixture?.engines() ?? {}, { ...fast, games: 10 });
    expect(report.failures.map((f) => f.property)).toContain("isolation");
  });
});

describe("runKit's static checks", () => {
  it("reports a manifest that disagrees with the engine", () => {
    const report = runKit(asEngines(toyGame()), {
      ...fast,
      games: 1,
      manifest: { ...toyManifest, hiddenInformation: false, players: { min: 2, max: 2 } },
    });
    expect(report.failures.filter((f) => f.property === "manifest").map((f) => f.message)).toEqual([
      "rules version 1: hiddenInformation differs between the engine and the manifest",
      "the engines allow 2–3 players over their option inputs, but the manifest says 2–2",
    ]);
  });

  it("reports option inputs the module refuses", () => {
    const report = runKit(asEngines(toyGame()), { ...fast, games: 1, optionInputs: [{ x: 1 }] });
    expect(report.failures).toEqual([
      {
        property: "schema",
        message: 'resolveOptions refused option input {"x":1}: BAD_OPTIONS',
        version: 1,
      },
    ]);
  });

  it("asks for a context when the config schema needs values", () => {
    const toy = toyGame();
    const report = runKit(asEngines({ ...toy, configSchema: toy.actionSchema }), { mode: "fast" });
    expect(report.failures.map((f) => f.message)).toEqual([
      "configSchema doesn't accept an empty configuration; pass context",
    ]);
  });

  it("uses the given context", () => {
    const toy = toyGame();
    const report = runKit(asEngines({ ...toy, configSchema: toy.actionSchema }), {
      mode: "fast",
      games: 1,
      context: { config: { card: 1 }, resources: [] },
    });
    expect(report.failures).toEqual([]);
  });

  it.each([
    [
      "players() returns an invalid range",
      { players: () => ({ min: 3, max: 2 }) },
      /invalid range/u,
    ],
    [
      "validateStart refuses everything",
      { validateStart: () => ({ code: "BAD_OPTIONS" }) },
      /refuses every seat count/u,
    ],
    [
      "the default timeout is out of range",
      { defaultTurnTimeoutDays: () => 31 },
      /defaultTurnTimeoutDays/u,
    ],
    ["catalog doesn't match its schema", { catalog: () => ({}) }, /catalogSchema/u],
    [
      "checkConfig returns something else",
      { checkConfig: () => ({ fine: true }) },
      /checkConfig must return/u,
    ],
    [
      "resolveOptions returns options outside the schema",
      { resolveOptions: () => ({ seats: "two" }) },
      /optionsSchema/u,
    ],
    [
      "resolveOptions doesn't accept its own options",
      {
        resolveOptions: (input: unknown) =>
          typeof input === "object" && input !== null && "resolved" in input
            ? { code: "BAD_OPTIONS" }
            : { resolved: true },
        optionsSchema: z.object({ resolved: z.literal(true) }),
      },
      /doesn't return its own options unchanged for \{\} \(02 §2\.1 rule 10\)/u,
    ],
    [
      // Changes its input to match what it returns: passes only if the kit compares the options
      // it held before the call (A15-P-5).
      "resolveOptions changes its input",
      {
        resolveOptions: (input: unknown) => {
          if (typeof input === "object" && input !== null && "resolved" in input) {
            const changed = input as { resolved: number };
            changed.resolved += 1;
            return { resolved: changed.resolved };
          }
          return { resolved: 1 };
        },
        optionsSchema: z.object({ resolved: z.number() }),
      },
      /doesn't return its own options unchanged/u,
    ],
    [
      "resolveOptions throws",
      {
        resolveOptions: () => {
          throw new Error("x");
        },
      },
      /threw Error: x/u,
    ],
    [
      "players() throws",
      {
        players: () => {
          throw new TypeError("y");
        },
      },
      /threw TypeError: y/u,
    ],
  ])("reports when %s", (_name, change, message) => {
    const report = runKit(asEngines({ ...toyGame(), ...change } as ReturnType<typeof toyGame>), {
      mode: "fast",
      games: 1,
    });
    expect(report.failures.map((f) => f.message).join("\n")).toMatch(message);
  });

  it("keeps at most five failures per property", () => {
    const report = runKit(brokenFixtures()["leaks other hands into a view"]?.engines() ?? {}, {
      mode: "fast",
      games: 20,
    });
    expect(report.failures.filter((f) => f.property === "secrecy")).toHaveLength(5);
  });

  it("reports resolveOptions throwing for one option input, and checkConfig's undeclared codes", () => {
    const toy = toyGame();
    const report = runKit(
      asEngines({
        ...toy,
        resolveOptions: (input, ctx) => {
          if (typeof input === "object" && input !== null && "boom" in input) {
            throw new Error("boom");
          }
          return toy.resolveOptions(input, ctx);
        },
        checkConfig: () => ({ code: "CONFIG" }),
      }),
      { mode: "fast", games: 1, optionInputs: [{ boom: 1 }, {}] },
    );
    expect(report.failures.map((f) => f.message)).toEqual([
      "checkConfig returned code CONFIG, which isn't in errorCodes",
      "resolveOptions threw Error: boom",
    ]);
  });

  it("reports module output it can't read, and exceptions that aren't Errors", () => {
    const toy = toyGame();
    const unreadable = runKit(
      asEngines({ ...toy, seatStatus: () => null as unknown as ("playing" | "out")[] }),
      { mode: "fast", games: 1 },
    );
    expect(unreadable.failures.map((f) => f.message).join("\n")).toMatch(
      /module output the kit can't read: TypeError/u,
    );
    const thrown = runKit(
      asEngines({
        ...toy,
        summary: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the kit must report any thrown value
          throw "not an error";
        },
      }),
      { mode: "fast", games: 1 },
    );
    expect(thrown.failures.map((f) => f.message).join("\n")).toMatch(/threw not an error/u);
  });

  it("fails worst cases that aren't real moves, and reports ones that throw", () => {
    const toy = toyGame();
    const worstCase =
      (marker: number, card?: number, seat = 0, wrongSeats = false) =>
      (_options: unknown, seats: number) => {
        const state = toy.setup({
          options: {},
          seats: wrongSeats ? seats + 1 : seats,
          rng: { nextInt: () => 0 },
        });
        return [
          { state: { ...state, marker }, seat, action: { card: card ?? state.hands[0]?.[0] ?? 1 } },
        ];
      };
    const messages = (marker: number, card?: number, seat?: number, wrong?: boolean): string[] =>
      runKit(
        asEngines({
          ...toy,
          test: { ...toy.test, worstCase: worstCase(marker, card, seat, wrong) },
        }),
        {
          mode: "fast",
          games: 1,
        },
      ).failures.map((f) => f.message);
    expect(messages(0)).toEqual([]);
    expect(messages(0, 99)).toContain(
      "worstCase input 0: the action doesn't validate (NOT_IN_HAND)",
    );
    expect(messages(0, undefined, 1)).toContain("worstCase input 0: seat 1 isn't in toAct");
    // P2-3: a worst case belongs to its combination's seat count.
    expect(messages(0, undefined, 0, true)).toContain(
      "worstCase input 0: its state isn't a 2-seat game",
    );
    const throwing = runKit(
      asEngines({
        ...toy,
        validate: (s, seat, a, res) => {
          if (s.marker === 1) throw new Error("slow path");
          return toy.validate(s, seat, a, res);
        },
        test: { ...toy.test, worstCase: worstCase(1) },
      }),
      { mode: "fast", games: 1 },
    );
    expect(throwing.failures.map((f) => f.message)).toContain(
      "worstCase input 0 threw Error: slow path",
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a CPU budget of %s, which would pass anything",
    (cpuBudgetMs) => {
      const report = runKit(asEngines(toyGame()), { mode: "fast", games: 1, cpuBudgetMs });
      expect(report.failures.map((f) => f.message)).toContain(
        `cpuBudgetMs must be a positive number; it is ${String(cpuBudgetMs)}`,
      );
    },
  );

  it("measures against the given CPU budget", () => {
    // About a millisecond per worst-case call: over a 0.01 ms budget, well within a 10 s one.
    const toy = toyGame();
    let sink = 0;
    const busy = {
      ...toy,
      validate: (...args: Parameters<typeof toy.validate>) => {
        if (args[0].marker === 7) for (let i = 0; i < 300_000; i += 1) sink = (sink + i) % 7919;
        return toy.validate(...args);
      },
      test: {
        ...toy.test,
        worstCase: (...args: Parameters<typeof toy.test.worstCase>) =>
          toy.test.worstCase(...args).map((c) => ({ ...c, state: { ...c.state, marker: 7 } })),
      },
    };
    const run = (cpuBudgetMs: number) =>
      runKit(asEngines(busy), {
        mode: "fast",
        games: 1,
        optionInputs: [{}],
        cpuBudgetMs,
      }).failures.map((f) => f.message);
    expect(run(0.01).join("\n")).toMatch(/over the 0\.01 ms budget at the 99th percentile/u);
    expect(run(10_000)).toEqual([]);
  });

  /**
   * The toy game whose worst-case states are marked, timed by a virtual clock: `validate` is
   * wrapped, and `cost(n)`, told the 1-based count of worst-case calls so far (game play isn't
   * counted), says how many milliseconds that call takes. Nothing else takes any time, so these
   * tests are exact whatever the host's load, and they use the injected clock (`cpuClock`).
   */
  const marked = (cost: (call: number) => number) => {
    const toy = toyGame();
    const calls = { count: 0 };
    const clock = { ms: 0 };
    const def = {
      ...toy,
      validate: (...args: Parameters<typeof toy.validate>) => {
        if (args[0].marker === 7) {
          calls.count += 1;
          clock.ms += cost(calls.count);
        }
        return toy.validate(...args);
      },
      test: {
        ...toy.test,
        worstCase: (...args: Parameters<typeof toy.test.worstCase>) =>
          toy.test.worstCase(...args).map((c) => ({ ...c, state: { ...c.state, marker: 7 } })),
      },
    };
    // One option input, so two worst-case inputs (two and three seats), one game each.
    const options = (cpuBudgetMs: number): KitOptions => ({
      mode: "fast",
      games: 1,
      optionInputs: [{}],
      cpuBudgetMs,
      cpuClock: () => clock.ms,
    });
    return { engines: asEngines(def), calls, options };
  };
  const cpuMessages = (report: ReturnType<typeof runKit>): string =>
    report.failures.map((f) => f.message).join("\n");

  it("fails a module slow on every call, after three over-budget runs of each sample", () => {
    const { engines, calls, options } = marked(() => 0.5);
    expect(runKit(engines, options(0.1)).failures.map((f) => f.message)).toEqual([
      "worstCase input 0 is over the 0.1 ms budget at the 99th percentile (2 samples over, the slowest at least 0.50 ms; a sample is the median of 5 runs)",
      "worstCase input 0 is over the 0.1 ms budget at the 99th percentile (2 samples over, the slowest at least 0.50 ms; a sample is the median of 5 runs)",
    ]);
    // Per input: the validity check, 10 warm-up runs, then 3 runs of each sample (3 over budget
    // decide its median) until one more sample than the 1 % allowance (1 of 100) is over budget.
    expect(calls.count).toBe(2 * (1 + 10 + 2 * 3));
  });

  it("reports the slowest sample, which is the median of its runs", () => {
    // Each sample's runs take 8, 0.5, 3.5, 0.5 and 6 ms (calls 12–16 are the first sample, after
    // the validity check and the warm-up runs): over, within, over, within and over a 2.5 ms
    // budget, so every sample takes all five runs and its median is 3.5 ms, not 6 or 8.
    const { engines, options } = marked((call) =>
      call <= 11 ? 0.2 : ([8, 0.5, 3.5, 0.5, 6][(call - 12) % 5] ?? 0),
    );
    expect(runKit(engines, options(2.5)).failures[0]?.message).toBe(
      "worstCase input 0 is over the 2.5 ms budget at the 99th percentile (2 samples over, the slowest at least 3.50 ms; a sample is the median of 5 runs)",
    );
  });

  it("fails a module slow on every second call, which a fastest-of-runs sample would pass", () => {
    // Half the calls are 2.5× over budget: every other sample holds three slow runs of five.
    const { engines, options } = marked((call) => (call % 2 === 0 ? 10 : 0));
    expect(cpuMessages(runKit(engines, options(4)))).toMatch(
      /over the 4 ms budget at the 99th percentile/u,
    );
  });

  it("fails a module slow on two calls in every three (CH8-S-1)", () => {
    // Any five back-to-back runs hold at least three slow ones, so every sample is over budget.
    const { engines, options } = marked((call) => (call % 3 === 0 ? 0 : 10));
    expect(cpuMessages(runKit(engines, options(4)))).toMatch(
      /over the 4 ms budget at the 99th percentile/u,
    );
  });

  it("passes a module slow only on an occasional call, as a pause is", () => {
    // Every 7th worst-case call is 2.5× over budget: about 14 of 100 single runs, far over the 1 %
    // allowance, but no five back-to-back runs hold more than one of them, so no median is slow.
    let slowCalls = 0;
    const { engines, calls, options } = marked((call) => {
      if (call % 7 !== 0) return 0;
      slowCalls += 1;
      return 10;
    });
    expect(runKit(engines, options(4)).failures).toEqual([]);
    // The slow calls really happened, often enough to fail a check of single runs.
    expect(slowCalls).toBeGreaterThanOrEqual(2 * 10);
    expect(calls.count).toBeGreaterThanOrEqual(2 * (1 + 10 + 100));
  });

  it("reads time only from the injected clock", () => {
    // A module that spins 0.3 ms of real time on every worst-case call, against a 0.1 ms budget:
    // the default clock fails it, a clock that never moves passes it...
    const { engines } = marked(() => {
      const until = performance.now() + 0.3;
      while (performance.now() < until) {
        // Real time passes; the virtual clock doesn't.
      }
      return 0;
    });
    const wallClock: KitOptions = { mode: "fast", games: 1, optionInputs: [{}], cpuBudgetMs: 0.1 };
    expect(cpuMessages(runKit(engines, wallClock))).toMatch(/over the 0\.1 ms budget/u);
    expect(runKit(engines, { ...wallClock, cpuClock: () => 0 }).failures).toEqual([]);
    // ...and one that moves 100 ms on every read fails even the toy game's microsecond calls.
    let now = 0;
    const racing = () => (now += 100);
    expect(
      cpuMessages(
        // The budget is named: CI's KIT_CPU_BUDGET_MS would otherwise set it (02 §6.6).
        runKit(asEngines(toyGame()), { mode: "fast", games: 1, cpuBudgetMs: 5, cpuClock: racing }),
      ),
    ).toMatch(/over the 5 ms budget at the 99th percentile/u);
  });

  it("charges busy work with this thread's CPU clock, and passes a fast module", () => {
    const cpuClock = threadCpuClock().now;
    const tooSlow = brokenFixtures()["is too slow on its worst case"]?.engines() ?? {};
    expect(
      cpuMessages(
        runKit(tooSlow, {
          mode: "fast",
          games: 1,
          stopAtFirstFailure: true,
          // Named, so CI's KIT_CPU_BUDGET_MS doesn't set it (02 §6.6).
          cpuBudgetMs: 5,
          cpuClock,
        }),
      ),
    ).toMatch(/over the 5 ms budget at the 99th percentile/u);
    expect(runKit(asEngines(toyGame()), { mode: "fast", games: 1, cpuClock }).failures).toEqual([]);
  });

  it("reports a worstCase that throws", () => {
    const toy = toyGame();
    const report = runKit(
      asEngines({
        ...toy,
        test: {
          ...toy.test,
          worstCase: () => {
            throw new Error("no");
          },
        },
      }),
      { mode: "fast", games: 1 },
    );
    expect(report.failures.map((f) => f.message)).toContain("worstCase threw Error: no");
  });

  it("reports a module whose hidden-information flag is wrong and whose perturbation is vacuous", () => {
    const toy = toyGame();
    const report = runKit(asEngines({ ...toy, test: { ...toy.test, perturbHidden: (s) => s } }), {
      mode: "fast",
      games: 30,
    });
    expect(report.failures.map((f) => f.message).join("\n")).toMatch(
      /changed another viewer's view in only 0 of \d+ samples/u,
    );
  });

  it("counts a deck-only perturbation by the state only when the module says no seat sees its hidden information", () => {
    const toy = toyGame();
    // Every hand is public, so the deck order is the only hidden information, and every viewer
    // gets the same view (the public's, with every hand), as the flag requires (02 §6.3).
    const deckOnly = (hiddenFromEveryone?: boolean) => ({
      ...toy,
      view: (s: Parameters<typeof toy.view>[0]) => ({ ...toy.view(s, null), peek: s.hands }),
      test: {
        ...toy.test,
        perturbHidden: (s: Parameters<typeof toy.view>[0]) => ({
          ...s,
          deck: [...s.deck].reverse(),
        }),
        ...(hiddenFromEveryone === undefined ? {} : { hiddenFromEveryone }),
      },
    });
    expect(runKit(asEngines(deckOnly(true)), { mode: "fast", games: 20 }).failures).toEqual([]);
    expect(
      runKit(asEngines(deckOnly()), { mode: "fast", games: 20 })
        .failures.map((f) => f.message)
        .join("\n"),
    ).toMatch(/changed another viewer's view in only 0 of/u);
  });

  it.each([
    ["sets hiddenFromEveryone while its seats see different hands", "seat 1"],
    ["sets hiddenFromEveryone while the public's view differs from the seats'", "the public"],
  ])("checks hiddenFromEveryone at every step: a module that %s fails", (name, who) => {
    const report = runKit(brokenFixtures()[name]?.engines() ?? {}, { mode: "fast", games: 3 });
    expect(report.failures.map((f) => f.message)).toContain(
      `hiddenFromEveryone is set, but ${who} gets a different view from seat 0 while the game is in progress`,
    );
  });

  it("refuses hiddenFromEveryone without hiddenInformation", () => {
    const toy = toyGame();
    const report = runKit(
      asEngines({
        ...toy,
        test: { ...toy.test, hiddenInformation: false, hiddenFromEveryone: true },
      }),
      { mode: "fast", games: 1 },
    );
    expect(report.failures.map((f) => f.message)).toContain(
      "hiddenFromEveryone is set but hiddenInformation isn't",
    );
  });

  it("counts a perturbation only when it changes another viewer's view, once any view can change", () => {
    const toy = toyGame();
    // Perturbs other hands only rarely: views change sometimes, but in under half the samples.
    let calls = 0;
    const rare = {
      ...toy,
      test: {
        ...toy.test,
        perturbHidden: (
          s: Parameters<typeof toy.view>[0],
          v: number | null,
          rng: Parameters<typeof toy.test.perturbHidden>[2],
        ) => {
          calls += 1;
          const deck = { ...s, deck: [...s.deck].reverse() };
          return calls % 5 === 0 ? toy.test.perturbHidden(deck, v, rng) : deck;
        },
      },
    };
    expect(
      runKit(asEngines(rare), { mode: "fast", games: 30 })
        .failures.map((f) => f.message)
        .join("\n"),
    ).toMatch(/changed another viewer's view in only/u);
  });
});

describe("how runKit makes seats leave (02 §4)", () => {
  it("declines only when enough seats remain, also resigns seats that haven't acted, and times out only seats that have", () => {
    const toy = toyGame();
    const seen = { declines: 0, unactedResigns: 0, timeouts: 0 };
    const acted = (s: Parameters<typeof toy.view>[0], seat: number) =>
      (s.hands[seat]?.length ?? 0) < 2 || s.scores[seat] !== 0;
    const watched = {
      ...toy,
      onResign: (...args: Parameters<typeof toy.onResign>) => {
        const [s, seat, , reason] = args;
        const playing = s.out.filter((o) => !o).length;
        if (reason === "decline") {
          if (playing - 1 < 2) throw new Error("declined below the minimum");
          seen.declines += 1;
        } else if (!acted(s, seat)) {
          seen.unactedResigns += 1;
        }
        return toy.onResign(...args);
      },
      onTimeout: (...args: Parameters<typeof toy.onTimeout>) => {
        if (!acted(args[0], args[1])) throw new Error("timed out before acting");
        seen.timeouts += 1;
        return toy.onTimeout(...args);
      },
    };
    expect(runKit(asEngines(watched), { mode: "fast", games: 200 }).failures).toEqual([]);
    expect(seen.declines).toBeGreaterThan(0);
    expect(seen.unactedResigns).toBeGreaterThan(0);
    expect(seen.timeouts).toBeGreaterThan(0);
  });
});

describe("runKit's test hooks (02 §6)", () => {
  it("fails a module without test.optionInputs, and plays its defaults", () => {
    const toy = toyGame();
    const hooks: Partial<typeof toy.test> = { ...toy.test };
    delete hooks.optionInputs;
    const report = runKit(asEngines({ ...toy, test: hooks as typeof toy.test }), {
      mode: "fast",
      games: 1,
    });
    expect(report.failures.map((f) => f.message)).toEqual([
      "test.optionInputs is missing: list the option sets the kit must play",
    ]);
    expect(report.games).toBe(2);
  });

  it.each([
    ["returns none", () => [], "test.optionInputs must return at least one option input"],
    [
      "throws",
      () => {
        throw new Error("no");
      },
      "test.optionInputs threw Error: no",
    ],
  ])("fails a module whose test.optionInputs %s", (_name, optionInputs, message) => {
    const toy = toyGame();
    const report = runKit(asEngines({ ...toy, test: { ...toy.test, optionInputs } }), {
      mode: "fast",
      games: 1,
    });
    expect(report.failures.map((f) => f.message)).toEqual([message]);
  });

  it("plays every option input the module lists, with its context and resources", () => {
    const toy = toyGame();
    const seen: unknown[] = [];
    const contextual = {
      ...toy,
      configSchema: toy.actionSchema,
      validate: (...args: Parameters<typeof toy.validate>) => {
        seen.push(args[3].dictionary?.id);
        return toy.validate(...args);
      },
      test: {
        ...toy.test,
        context: () => ({ config: { card: 1 }, resources: [] }),
        resources: (options: { open?: boolean | undefined }) => ({
          dictionary: {
            id: options.open === true ? "open" : "closed",
            version: 1,
            has: () => true,
          },
        }),
      },
    };
    const report = runKit(asEngines(contextual), { mode: "fast", games: 1 });
    expect(report.failures).toEqual([]);
    expect(report.games).toBe(4);
    expect(new Set(seen)).toEqual(new Set(["open", "closed", undefined]));
  });

  it("fails a module whose test.context throws", () => {
    const toy = toyGame();
    const report = runKit(
      asEngines({
        ...toy,
        test: {
          ...toy.test,
          context: () => {
            throw new Error("ctx");
          },
        },
      }),
      { mode: "fast", games: 1 },
    );
    expect(report.failures.map((f) => f.message)).toEqual(["test.context threw Error: ctx"]);
  });
});

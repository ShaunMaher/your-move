import type { Resources } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import { runKit, type KitOptions } from "./kit.js";
import { asEngines, brokenFixtures, toyGame, toyManifest } from "./test-support.js";

/** A dictionary that knows every word: the "reads resources in setup" fixture needs one. */
const resources: Resources = { dictionary: { id: "all", version: 1, has: () => true } };
const fast: KitOptions = { mode: "fast", resources, manifest: toyManifest };

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
      (marker: number, card?: number, seat = 0) =>
      () => {
        const state = toy.setup({ options: {}, seats: 2, rng: { nextInt: () => 0 } });
        return [
          { state: { ...state, marker }, seat, action: { card: card ?? state.hands[0]?.[0] ?? 1 } },
        ];
      };
    const messages = (marker: number, card?: number, seat?: number): string[] =>
      runKit(
        asEngines({ ...toy, test: { ...toy.test, worstCase: worstCase(marker, card, seat) } }),
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
      /changed the state in only 0 of \d+ samples/u,
    );
  });

  it("counts a perturbation that only reorders a deck no viewer sees, when no view ever changes", () => {
    const toy = toyGame();
    const deckOnly = {
      ...toy,
      test: {
        ...toy.test,
        perturbHidden: (s: Parameters<typeof toy.view>[0]) => ({
          ...s,
          deck: [...s.deck].reverse(),
        }),
      },
    };
    expect(runKit(asEngines(deckOnly), { mode: "fast", games: 20 }).failures).toEqual([]);
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

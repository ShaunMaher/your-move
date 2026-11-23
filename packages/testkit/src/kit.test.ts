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
    expect(report.games).toBe(100);
  });
});

describe("runKit on the broken fixtures (02 §6)", () => {
  it.each(Object.entries(brokenFixtures()))("fails a module that %s", (_name, fixture) => {
    const report = runKit(fixture.engines(), fast);
    expect(report.failures.map((failure) => failure.property)).toContain(fixture.property);
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
      "rules version 1: players 2–3 are outside the manifest's 2–2",
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

  it("times worst cases whose action is illegal, and reports ones that throw", () => {
    const toy = toyGame();
    const worstCase = (illegal: number) => () => {
      const state = toy.setup({ options: {}, seats: 2, rng: { nextInt: () => 0 } });
      return [{ state: { ...state, marker: illegal }, seat: 0, action: { card: 99 } }];
    };
    const legal = runKit(asEngines({ ...toy, test: { ...toy.test, worstCase: worstCase(0) } }), {
      mode: "fast",
      games: 1,
    });
    expect(legal.failures).toEqual([]);
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
    expect(report.failures.map((f) => f.message).join("\n")).toMatch(/must change at least half/u);
  });
});

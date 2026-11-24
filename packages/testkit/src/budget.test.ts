import { afterEach, describe, expect, it, vi } from "vitest";

import { CPU_BUDGET_VARIABLE, environmentCpuBudget, readCpuBudget } from "./budget.js";
import { runKit } from "./kit.js";
import { asEngines, toyGame } from "./test-support.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the CPU budget as text (02 §6.6, 08 T25)", () => {
  it.each([
    ["neither: the default", undefined, undefined, undefined],
    ["an empty variable: the default", undefined, "", undefined],
    ["the variable", undefined, "20", 20],
    ["the flag", "12", undefined, 12],
    ["the flag over the variable", "8", "20", 8],
    ["the smallest", "1", undefined, 1],
    ["the largest", "50", undefined, 50],
  ])("takes %s", (_name, flag, variable, ms) => {
    expect(readCpuBudget(flag, variable)).toEqual({ ok: true, ms });
  });

  it.each([
    ["--cpu-budget-ms", "0", undefined],
    ["--cpu-budget-ms", "51", undefined],
    ["--cpu-budget-ms", "12.5", undefined],
    ["--cpu-budget-ms", "1e1", undefined],
    ["--cpu-budget-ms", " 20", undefined],
    ["--cpu-budget-ms", "0x14", undefined],
    ["--cpu-budget-ms", "", "20"],
    ["--cpu-budget-ms", "fast", "20"],
    [CPU_BUDGET_VARIABLE, undefined, "-5"],
    [CPU_BUDGET_VARIABLE, undefined, "Infinity"],
    [CPU_BUDGET_VARIABLE, undefined, "1000"],
  ])("refuses an unusable %s (%j, %j)", (source, flag, variable) => {
    expect(readCpuBudget(flag, variable)).toEqual({
      ok: false,
      problem: `${source} must be a whole number of milliseconds from 1 to 50`,
    });
  });

  it("reads the variable from the host environment", () => {
    vi.stubEnv(CPU_BUDGET_VARIABLE, "17");
    expect(environmentCpuBudget()).toBe("17");
  });
});

describe("runKit's budget", () => {
  it("is the host's KIT_CPU_BUDGET_MS when no option is given, and the option wins over it", () => {
    // The toy game's worst case is far under 1 ms; an unusable variable shows which one was read.
    vi.stubEnv(CPU_BUDGET_VARIABLE, "100");
    const fromEnvironment = runKit(asEngines(toyGame()), { mode: "fast", games: 1 });
    expect(fromEnvironment.failures.map((failure) => failure.message)).toContain(
      `${CPU_BUDGET_VARIABLE} must be a whole number of milliseconds from 1 to 50`,
    );
    const withOption = runKit(asEngines(toyGame()), { mode: "fast", games: 1, cpuBudgetMs: 5 });
    expect(withOption.failures).toEqual([]);
  });

  it("is 5 ms without the variable, as on a developer machine", () => {
    vi.stubEnv(CPU_BUDGET_VARIABLE, "");
    expect(runKit(asEngines(toyGame()), { mode: "fast", games: 1 }).failures).toEqual([]);
  });
});

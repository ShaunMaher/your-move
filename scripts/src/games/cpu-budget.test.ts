import { describe, expect, it } from "vitest";

import { cpuBudget } from "./cpu-budget.js";

describe("the kit's CPU budget for games:verify (08 T25)", () => {
  it.each([
    ["neither: the kit's default", undefined, undefined, undefined],
    ["an empty variable: the kit's default", undefined, "", undefined],
    ["the variable", undefined, "20", 20],
    ["the flag", "12.5", undefined, 12.5],
    ["the flag over the variable", "8", "20", 8],
  ])("takes %s", (_name, flag, variable, ms) => {
    expect(cpuBudget(flag, variable)).toEqual({ ok: true, ms });
  });

  it.each([
    ["--cpu-budget-ms", "0", undefined],
    ["--cpu-budget-ms", "fast", "20"],
    ["--cpu-budget-ms", "", undefined],
    ["KIT_CPU_BUDGET_MS", undefined, "-5"],
    ["KIT_CPU_BUDGET_MS", undefined, "Infinity"],
  ])("refuses an unusable %s", (source, flag, variable) => {
    expect(cpuBudget(flag, variable)).toEqual({
      ok: false,
      problem: `${source} must be a positive number of milliseconds`,
    });
  });
});

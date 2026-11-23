/**
 * The kit's CPU budget check (docs/spec/02-game-framework.md §6.6).
 */
import { isGameError, type Resources, type Seat } from "@your-move/sdk";

import { seededRandom } from "./random.js";
import { errorName, jsonClone, type Combo, type Reporter } from "./report.js";
import type { KitOptions } from "./types.js";

/**
 * The CPU budget (02 §6.6, 08 T25): `validate` + `preview` + `apply` on each `worstCase` input,
 * timed over many runs; the 99th percentile must stay within the budget.
 */
export function checkCpu(
  report: Reporter,
  combo: Combo,
  seed: number,
  kitOptions: KitOptions,
  resources: Resources,
): void {
  const { def, options, seats } = combo;
  const where = { version: def.version, seats, seed };
  const budget = kitOptions.cpuBudgetMs ?? 5;
  const runs = kitOptions.mode === "full" ? 100 : 20;
  let cases: readonly { state: unknown; seat: Seat; action: unknown }[];
  try {
    cases = def.test.worstCase(options, seats, seededRandom(seed));
  } catch (error) {
    report.fail("cpu", `worstCase threw ${errorName(error)}`, where);
    return;
  }
  for (const [index, { state, seat, action }] of cases.entries()) {
    const times: number[] = [];
    try {
      for (let run = 0; run < runs; run += 1) {
        const copy = jsonClone(state);
        const start = performance.now();
        const verdict = def.validate(copy, seat, action, resources);
        def.preview?.(copy, seat, action, resources);
        if (!isGameError(verdict)) def.apply(copy, seat, action, seededRandom(run));
        times.push(performance.now() - start);
      }
    } catch (error) {
      report.fail("cpu", `worstCase input ${String(index)} threw ${errorName(error)}`, where);
      continue;
    }
    // The 99th percentile: the slowest of the fastest 99 % of runs.
    const p99 = [...times]
      .sort((a, b) => a - b)
      .slice(0, Math.ceil(times.length * 0.99))
      .reduce((slowest, time) => Math.max(slowest, time), 0);
    if (p99 > budget) {
      report.fail(
        "cpu",
        `worstCase input ${String(index)} took ${p99.toFixed(2)} ms (p99), over the ${String(budget)} ms budget`,
        where,
      );
    }
  }
}

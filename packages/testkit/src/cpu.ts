/**
 * The kit's CPU budget check (docs/spec/02-game-framework.md §6.6).
 */
import { isGameError, type Seat } from "@your-move/sdk";

import { seededRandom } from "./random.js";
import { errorName, jsonClone, type Combo, type Reporter } from "./report.js";
import type { KitOptions } from "./types.js";

/** Untimed runs first, so the timed ones measure warm code rather than the JIT. */
const WARM_UP_RUNS = 10;
/** Timed runs per `worstCase` input. */
const RUNS = { fast: 100, full: 300 } as const;
/** The default budget, 08 T25. */
const DEFAULT_CPU_BUDGET_MS = 5;

/**
 * The CPU budget (02 §6.6, 08 T25): `validate` + `preview` + `apply` on each `worstCase` input,
 * timed over many runs on the host running the kit, after warm-up runs; the 99th percentile must
 * stay within the budget (`cpuBudgetMs`, default 5 ms). The slowest 1 % of runs are dropped, so a
 * single garbage-collection pause doesn't fail a correct module, and timing stops as soon as more
 * runs than that are over budget, so a slow module fails quickly.
 *
 * A worst case must be a real move: its seat in `toAct` and its action valid, and a playable seat
 * count must have at least one, or the check would be vacuous.
 */
export function checkCpu(
  report: Reporter,
  combo: Combo,
  seed: number,
  kitOptions: KitOptions,
): void {
  const { def, options, seats, resources } = combo;
  const where = { version: def.version, seats, seed };
  const budget = kitOptions.cpuBudgetMs ?? DEFAULT_CPU_BUDGET_MS;
  if (!(Number.isFinite(budget) && budget > 0)) {
    // A budget nothing can exceed would pass every module.
    report.fail("cpu", `cpuBudgetMs must be a positive number; it is ${String(budget)}`, where);
    return;
  }
  const runs = RUNS[kitOptions.mode];
  // Runs allowed over budget: those above the 99th percentile.
  const allowed = runs - Math.ceil(runs * 0.99);
  let returned: unknown;
  try {
    returned = def.test.worstCase(options, seats, seededRandom(seed));
  } catch (error) {
    report.fail("cpu", `worstCase threw ${errorName(error)}`, where);
    return;
  }
  // A JavaScript module may return anything; an empty list would make the check vacuous.
  const cases = (Array.isArray(returned) ? returned : []) as readonly {
    state: unknown;
    seat: Seat;
    action: unknown;
  }[];
  if (cases.length === 0) {
    report.fail("cpu", "worstCase returned no input for a playable seat count", where);
    return;
  }
  for (const [index, { state, seat, action }] of cases.entries()) {
    const at = `worstCase input ${String(index)}`;
    try {
      if (!def.toAct(state).includes(seat)) {
        report.fail("cpu", `${at}: seat ${String(seat)} isn't in toAct`, where);
        continue;
      }
      const verdict = def.validate(jsonClone(state), seat, action, resources);
      if (isGameError(verdict)) {
        report.fail("cpu", `${at}: the action doesn't validate (${verdict.code})`, where);
        continue;
      }
      let over = 0;
      let slowest = 0;
      for (let run = 0; run < WARM_UP_RUNS + runs && over <= allowed; run += 1) {
        const copy = jsonClone(state);
        const start = performance.now();
        def.validate(copy, seat, action, resources);
        def.preview?.(copy, seat, action, resources);
        def.apply(copy, seat, action, seededRandom(run));
        const time = performance.now() - start;
        if (run >= WARM_UP_RUNS && time > budget) {
          over += 1;
          slowest = Math.max(slowest, time);
        }
      }
      if (over > allowed) {
        report.fail(
          "cpu",
          `${at} is over the ${String(budget)} ms budget at the 99th percentile (${String(over)} runs over, up to ${slowest.toFixed(2)} ms)`,
          where,
        );
      }
    } catch (error) {
      report.fail("cpu", `${at} threw ${errorName(error)}`, where);
    }
  }
}

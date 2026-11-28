/**
 * The kit's CPU budget check (docs/spec/02-game-framework.md §6.6).
 */
import { isGameError, type Seat } from "@your-move/sdk";

import { DEFAULT_CPU_BUDGET_MS } from "./budget.js";
import { seededRandom } from "./random.js";
import { errorName, jsonClone, type Combo, type Reporter } from "./report.js";
import type { KitOptions } from "./types.js";

/** Untimed runs first, so the timed ones measure warm code rather than the JIT. */
const WARM_UP_RUNS = 10;
/** Timed samples per `worstCase` input. */
const SAMPLES = { fast: 100, full: 300 } as const;
/**
 * Back-to-back runs per sample; the sample is the fastest of them. A run the host preempted or
 * paused for garbage collection is slow on its own, while code that really is slow is slow in
 * every one (a full `pnpm test`, 16 threads busy, showed single 9 ms runs of a 0.5 ms p99 input).
 */
const REPETITIONS = 3;

/**
 * The CPU budget (02 §6.6, 08 T25): `validate` + `preview` + `apply` on each `worstCase` input,
 * timed on the host running the kit, after warm-up runs. Each timed sample is the fastest of
 * `REPETITIONS` back-to-back runs on fresh copies of the state, and the 99th percentile of the
 * samples must stay within the budget (`cpuBudgetMs`, default 5 ms). The slowest 1 % of samples are
 * dropped, and timing stops as soon as more samples than that are over budget, so a slow module
 * fails quickly.
 *
 * A sample's remaining runs are skipped once one is within budget: the fastest run is then within
 * budget whatever the others take, so the verdict and the slowest over-budget sample are exactly
 * those of always running all of them, and a fast module costs about one run per sample.
 *
 * A worst case must be a real move of its combination: a game with that many seats, its seat in
 * `toAct` and its action valid; and a playable seat count must have at least one, or the check
 * would be vacuous.
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
  const samples = SAMPLES[kitOptions.mode];
  // Samples allowed over budget: those above the 99th percentile.
  const allowed = samples - Math.ceil(samples * 0.99);
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
      const status = def.seatStatus(state) as readonly unknown[];
      if (!Array.isArray(status) || status.length !== seats) {
        report.fail("cpu", `${at}: its state isn't a ${String(seats)}-seat game`, where);
        continue;
      }
      if (!def.toAct(state).includes(seat)) {
        report.fail("cpu", `${at}: seat ${String(seat)} isn't in toAct`, where);
        continue;
      }
      const verdict = def.validate(jsonClone(state), seat, action, resources);
      if (isGameError(verdict)) {
        report.fail("cpu", `${at}: the action doesn't validate (${verdict.code})`, where);
        continue;
      }
      /** One run of the three calls on a fresh copy of the state, in milliseconds. */
      const time = (seed: number): number => {
        const copy = jsonClone(state);
        const start = performance.now();
        def.validate(copy, seat, action, resources);
        def.preview?.(copy, seat, action, resources);
        def.apply(copy, seat, action, seededRandom(seed));
        return performance.now() - start;
      };
      for (let run = 0; run < WARM_UP_RUNS; run += 1) time(run);
      let over = 0;
      let slowest = 0;
      for (let sample = 0; sample < samples && over <= allowed; sample += 1) {
        // Every run of a sample does the same work: the same state, action and random seed.
        let fastest = time(sample);
        for (let run = 1; run < REPETITIONS && fastest > budget; run += 1) {
          fastest = Math.min(fastest, time(sample));
        }
        if (fastest > budget) {
          over += 1;
          slowest = Math.max(slowest, fastest);
        }
      }
      if (over > allowed) {
        report.fail(
          "cpu",
          `${at} is over the ${String(budget)} ms budget at the 99th percentile (${String(over)} samples over, the slowest ${slowest.toFixed(2)} ms; a sample is the fastest of ${String(REPETITIONS)} runs)`,
          where,
        );
      }
    } catch (error) {
      report.fail("cpu", `${at} threw ${errorName(error)}`, where);
    }
  }
}

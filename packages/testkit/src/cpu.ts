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
 * Back-to-back runs per sample; the sample is their median. A run the host preempted or paused for
 * garbage collection is slow on its own (a full `pnpm test`, 16 threads busy, showed single 9 ms
 * runs of a 0.5 ms p99 input), while code slow on most calls is slow in most runs. The median,
 * not the fastest, so a module slow on two calls in three fails (CH8-S-1); of five, not three, so
 * two slow runs in one sample are filtered too (a median of three still failed the paths engine
 * once under two full parallel `pnpm test` runs at once).
 */
const REPETITIONS = 5;
/** Runs on one side of the budget that decide a sample: a majority of its runs. */
const MAJORITY = Math.floor(REPETITIONS / 2) + 1;

/**
 * The CPU budget (02 §6.6, 08 T25): `validate` + `preview` + `apply` on each `worstCase` input,
 * timed on the host running the kit with `cpuClock` (CPU time where the caller passes a CPU clock,
 * such as `threadCpuClock()`, otherwise `performance.now()`), after warm-up runs. The median still
 * matters with a CPU clock: garbage collection and JIT pauses on the calling thread are CPU time
 * too. Each timed sample is the median of
 * `REPETITIONS` back-to-back runs on fresh copies of the state and the action, and the 99th
 * percentile of the samples must stay within the budget (`cpuBudgetMs`, default 5 ms). The slowest
 * 1 % of samples are dropped, and timing stops as soon as more samples than that are over budget,
 * so a slow module fails quickly.
 *
 * A sample stops as soon as a majority of its runs are on one side of the budget, which decides its
 * median. For a module whose cost doesn't depend on earlier calls, that doesn't change the result,
 * and a fast module costs about three runs per sample. An over-budget sample is reported by the
 * fastest of its over-budget runs: its median if all its runs were taken, a lower bound otherwise.
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
  // CPU time where the caller passes a CPU clock, otherwise wall time (02 §6.6).
  const clock = kitOptions.cpuClock ?? (() => performance.now());
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
      /**
       * One run of the three calls on fresh copies of the state and the action (a module can't
       * carry anything from one run to the next on them), in milliseconds.
       */
      const time = (rngSeed: number): number => {
        const copy = jsonClone(state);
        const move = jsonClone(action);
        const start = clock();
        def.validate(copy, seat, move, resources);
        def.preview?.(copy, seat, move, resources);
        def.apply(copy, seat, move, seededRandom(rngSeed));
        return clock() - start;
      };
      for (let run = 0; run < WARM_UP_RUNS; run += 1) time(run);
      let over = 0;
      let slowest = 0;
      for (let sample = 0; sample < samples && over <= allowed; sample += 1) {
        // Every run of a sample does the same work, with a random seed no warm-up run used.
        let within = 0;
        const overRuns: number[] = [];
        while (within < MAJORITY && overRuns.length < MAJORITY) {
          const ms = time(WARM_UP_RUNS + sample);
          if (ms > budget) overRuns.push(ms);
          else within += 1;
        }
        if (overRuns.length >= MAJORITY) {
          over += 1;
          slowest = Math.max(slowest, Math.min(...overRuns));
        }
      }
      if (over > allowed) {
        report.fail(
          "cpu",
          `${at} is over the ${String(budget)} ms budget at the 99th percentile (${String(over)} samples over, the slowest at least ${slowest.toFixed(2)} ms; a sample is the median of ${String(REPETITIONS)} runs)`,
          where,
        );
      }
    } catch (error) {
      report.fail("cpu", `${at} threw ${errorName(error)}`, where);
    }
  }
}

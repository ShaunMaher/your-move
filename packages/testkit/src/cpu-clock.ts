/**
 * A CPU-time clock for the kit's CPU budget check (docs/spec/02-game-framework.md §6.6), for hosts
 * that offer one: `runKit(engines, { cpuClock: threadCpuClock().now })`.
 *
 * The kit's default clock is `performance.now()`, a wall clock: on a busy host it also counts the
 * time a run spends waiting for a core, which is the host's load, not the module's cost (08 T25 is
 * about per-call CPU). Node reports the CPU time of the calling thread; this module looks it up
 * defensively, as `environmentCpuBudget` looks up the environment, so the testkit still loads no
 * host types and runs anywhere.
 *
 * @packageDocumentation
 */

/** Microseconds of CPU time, as Node's `process.threadCpuUsage()` and `process.cpuUsage()` report. */
interface CpuUsage {
  readonly user: number;
  readonly system: number;
}

/** The parts of a host this module looks for. */
interface Host {
  readonly process?: {
    readonly threadCpuUsage?: () => CpuUsage;
    readonly cpuUsage?: () => CpuUsage;
  };
  readonly performance?: { now(): number };
}

/**
 * A clock for `KitOptions.cpuClock`, and what it measures.
 *
 * @public
 */
export interface CpuClock {
  /** The clock, in milliseconds. */
  readonly now: () => number;
  /** What it measures, for logs. */
  readonly source: "thread CPU time" | "process CPU time" | "wall clock";
}

const milliseconds = (usage: CpuUsage): number => (usage.user + usage.system) / 1000;

/**
 * The best CPU clock the host offers:
 * - the calling thread's CPU time (Node's `process.threadCpuUsage()`, Node 23.9 and later);
 * - otherwise the whole process's CPU time (`process.cpuUsage()`), which also counts the process's
 *   other threads (garbage collection helpers, other test workers when they are threads), so it
 *   can only overstate a run's cost: a slow module still fails, a fast one may rarely be charged
 *   for its neighbours;
 * - otherwise the wall clock, the kit's default.
 *
 * Both CPU clocks count the calling thread (or process) only while it runs: not time waiting for a
 * core, nor time blocked. Their resolution depends on the kernel: microseconds where it accounts
 * CPU time precisely, otherwise one scheduler tick (1–4 ms; about 1 ms on the Linux machines
 * measured), so with a 5 ms budget a run is judged to within about a tick. `host` is for tests.
 *
 * @public
 */
export function threadCpuClock(host: Host = globalThis as Host): CpuClock {
  const process = host.process;
  const thread = process?.threadCpuUsage;
  if (typeof thread === "function") {
    return { now: () => milliseconds(thread.call(process)), source: "thread CPU time" };
  }
  const whole = process?.cpuUsage;
  if (typeof whole === "function") {
    return { now: () => milliseconds(whole.call(process)), source: "process CPU time" };
  }
  const wall = host.performance ?? performance;
  return { now: () => wall.now(), source: "wall clock" };
}

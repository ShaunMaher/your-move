---
"@your-move/testkit": minor
---

The CPU budget check can time in CPU time. `runKit` takes a `cpuClock` option (milliseconds;
default `performance.now()`, so the kit stays Web-standard), and the new
`@your-move/testkit/cpu-clock` entry exports `threadCpuClock()`, a clock of the calling thread's
CPU time on Node (`process.threadCpuUsage()`, falling back to `process.cpuUsage()`, then to the
wall clock) and the `CpuClock` type. Pass `cpuClock: threadCpuClock().now` in a game package's kit
test so that a busy machine's load doesn't count against the game (02 §6.6, 08 T25).

Each timed sample is now the median of five back-to-back runs of `validate` + `preview` + `apply`
on fresh copies of the state and the action, so a run or two slowed by a garbage-collection pause
don't fail a module that is well within budget, while code slow on most calls still fails. The
timed runs no longer reuse the warm-up runs' random seeds. The 99th-percentile rule, its allowance,
the warm-up and the budget are unchanged. A sample stops once three of its runs are on the same
side of the budget; for a module whose cost doesn't depend on earlier calls, that doesn't change
the result. The failure message now counts samples over budget and gives a lower bound on the
slowest one.

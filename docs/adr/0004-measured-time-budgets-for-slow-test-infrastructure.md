# 4. Measured time budgets for slow test infrastructure, never retries

Status: accepted (2026-11-24)

## Context

11 §4 treats a flaky test as a bug and forbids automatic retries (`retries: 0`). The e2e smoke tests
still failed intermittently on the shared CI runner, a slow `qemu64` VM that often runs two or three
pipelines at once (issue #7). Their logs and traces showed the cause:

- Playwright never charges a browser's launch to a test, but it does charge the **first page** of a
  freshly launched browser to whichever test runs first. On the loaded runner that page took 28–30 s,
  against the 30 s test timeout.
- One failure was a real launch hang, where the browser never responded.

The same pattern appeared with the generic test kit's CPU budget. Garbage-collection or host pauses
on the runner reached 15 ms, against a 5 ms budget, for a worst case whose 99th percentile is
0.03–0.09 ms on a developer machine.

Retrying would hide real failures as well as these ones. Raising every timeout would make real
hangs slow to fail and would blur what the tests are measuring.

## Decision

- **Infrastructure costs get their own measured budgets, separate from the per-test timeout, and
  never retries.** Each budget's size and the measurement behind it are recorded beside it in code.
- **e2e** (`tests/e2e/src/budgets.ts`):
  - Each worker first opens the app once in a throwaway context, under a 90 s warm-up budget. That
    is 3× the first-page times that failed.
  - Browser launch gets an explicit 120 s, about 2× the slowest successful CI launch.
  - Tests keep 30 s, except the tests in which two people play a game: in `game.spec.ts` a full
    game has its own budget (120 s, `GAME_TEST_TIMEOUT_MS`) and the short resign test 60 s
    (`RESIGN_TEST_TIMEOUT_MS`), and the rematch in `opponents.spec.ts` (alpha A12: a short game
    with a pass each, then a second game picked from the list; alpha A15: then a third from the
    finished game's Rematch button, opened by both players) 90 s (`REMATCH_TEST_TIMEOUT_MS`, 5–6 s
    locally before A15; with it 6–8 s with a warm browser, 12–15 s as a shard's first test), and
    the no-play hint in `no-play.spec.ts` (alpha A14: the short game's steps and the word list's
    download and search, no moves) 60 s (`NO_PLAY_TEST_TIMEOUT_MS`, 2–3 s locally), and the
    email invite in `invites.spec.ts` (alpha A17: a game for an address with no account, the
    second person's sign-up from its invitation email, a pass each and the unsubscribe page) 60 s
    (`INVITE_TEST_TIMEOUT_MS`, 6–10 s locally). These are
    margins over local measurements, not CI ones; each is re-measured
    on the CI runner from the first pipeline that runs it, and then set from that.
  - CI runs one worker per job.
- **Test kit CPU budget** (`KIT_CPU_BUDGET_MS`, 08 T25):
  - CI sets one calibrated value (20 ms, 4×) for every kit run.
  - Developer machines keep 5 ms, so every local `pnpm test` and `games:verify` enforces the real
    budget.
  - Each timed sample is the median of five back-to-back runs (02 §6.6, added 2026-11-28): a
    full parallel `pnpm test` on a developer machine still produced single 9 ms runs of an input
    whose 99th percentile is 0.5 ms, and a preempted run is slow alone while code slow on most
    calls is slow in most runs. The median, not the fastest run, so that a module slow on two calls
    in three still fails; of five, because a median of three still failed the paths engine under
    two full parallel test runs at once, where two slow runs landed in one sample. This is a measurement of
    code cost, not a retry: for a module whose cost doesn't depend on earlier calls, the verdict is
    that of always timing all five runs of every sample (the kit stops a sample once three runs
    decide its median), and the allowance and early stop over samples are unchanged.
- **Diagnosability:** when a job fails because of the runner, it prints the runner's CPU model,
  load and memory, so slow infrastructure is visible rather than guessed at.

## Consequences

- The first test is now protected from cold-browser cost. A runner loaded enough to make ordinary
  tests exceed 30 s will still fail them, and should; the fix for that is runner capacity (the
  owner's VM CPU type and concurrency settings).
- In CI, third-party games are checked against the calibrated CPU budget, not the real one. The
  real budget is enforced only where developers run the checks.
- Each budget is a number someone measured. When the runner changes, re-measure the numbers rather
  than adding retries.

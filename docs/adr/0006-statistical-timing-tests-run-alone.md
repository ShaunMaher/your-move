# 6. Statistical timing tests run alone, never retried

Status: accepted (2026-11-25)

## Context

06 §3.2 and Q3 require `/otp/request` and `/otp/verify` to take indistinguishable time whether or
not an address has an account, and M2 tests that statistically
(`apps/node/src/auth-timing.test.ts`). That file does not check behaviour. It times thousands of
requests and compares them, so its result depends on everything else the machine is doing.

In MR !14 it ran inside the ordinary `test` job on the shared amd64 runner, a slow `qemu64` VM that
often runs several pipelines at once. There it failed: the power check, which plants one extra
indexed SELECT and must detect it, measured nothing (z = 0.03), and two comparisons ran past their
120 s timeouts. The same file takes seconds on a developer laptop. The suite's first design was not
reliable even there: at 200 samples per arm, its |z| < 4 pass bound and its z > 4 power check
overlapped, and both failed now and then on a quiet machine.

Retrying would hide real regressions as well as noise (11 §4). Loosening the bounds until the
loaded runner passes would leave a test that detects nothing.

## Decision

- **Statistical timing tests are measurements.** They run in a job of their own, `test:timing`,
  and never alongside another suite. `pnpm test` skips them, so the `test` job does too. `test:timing` runs on the arm64
  runner, after this pipeline's other arm64 job (`build:image:arm64`) has
  finished. It is a required job.
- **The suite is designed to pass on a quiet machine**, with the evidence recorded in the file's
  header:
  - a paired design that cancels drift;
  - an effect-size bound that sits well below the planted SELECT's effect;
  - a power check that requires the planted effect to exceed that bound;
  - time limits measured locally and recorded beside each test (ADR 0004).
- **The deterministic parity checks stay in every test job**: byte-identical responses, and the
  same repository calls with the same amounts on every path (`apps/node/src/auth-parity.test.ts`).
  They catch most regressions without timing anything.
- **Developers and coders run the timing file locally** before handing off any change to the
  sign-in paths (`pnpm test:timing`, which runs only that file; plain `pnpm test`
  skips it). A real timing difference is cheaper to find on a quiet laptop than in
  CI.
- **If the arm64 runner proves noisy, re-measure; never retry.** Take the job log's shifts and the
  runner report, compare them with the header's local numbers, and change the job, the runner or
  the documented bounds from that evidence. A change to the bounds keeps the power check's planted
  SELECT above the bound. If no quiet runner exists, the job is quarantined with an issue (11 §4),
  and the local run before hand-off is the check until it is restored.

## Addendum: game creation with a typed address (alpha A17, 2026-11-27)

Q3 (06 §6.1) needs `POST /api/v1/games` with a typed address to take indistinguishable time
whether the address has an account, is suppressed or is over the inbound cap (review A17-S-7). The
same file now times those cases with the same design and the same 3% bound, each request from a
creator of its own. A creation takes about 2.8 ms, so one planted SELECT (about 70 µs, 2.5%) sits
just under the bound; its power check plants **two** (+3.9% to +4.1% locally) and the bound is not
loosened. Coders run `pnpm test:timing` before handing off changes to game creation's handling of
typed addresses too; the file now takes about 70 s on a developer laptop.

## Consequences

- One more job per pipeline, on the arm64 runner, starting only after its other arm64 work (the arm64 image build). The
  pipeline takes longer by the suite's runtime there.
- A change that slows one sign-in path relative to another still fails a merge request: the
  deterministic checks fail in `test`, or the measured shift fails in `test:timing`.
- The bounds and time limits are numbers someone measured on one machine. When the runner or the
  suite changes, re-measure them as ADR 0004 says.

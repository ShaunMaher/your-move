# Alpha chores 8 review: resolutions

This record covers the review of `alpha-chores-8`: the kit's CPU budget check, which under a fully loaded host failed the `paths` engine (0.2–0.5 ms per move) at 7–10 ms, because a wall clock counts time spent waiting for a core (spec v0.9.46). The check now times each sample in the calling thread's CPU time where the host offers it, through an injected clock (`@your-move/testkit/cpu-clock`), and takes the median of five runs per sample. It had two rounds of the picky review (CH8-P, CH8-P2) and of the security review (CH8-S, CH8-S2); the owner resolved the merge with chores 9's runner wording and signed off.

| ID | Outcome | Where |
|---|---|---|
| CH8-S-1 | Fixed (owner decision): the median of five, not the fastest of three, so a module slow on two calls in three, or on every second call, fails; tested. | `packages/testkit/src/cpu.ts`, 02 §6.6 |
| CH8-S-2 | Fixed in the spec: the early stop doesn't change the result for a module whose cost doesn't depend on earlier calls. | 02 §6.6, `cpu.ts` |
| CH8-S-3 | Fixed: T25 and F-5 say the check catches honest slow code; a malicious package is T27's residual. | 08 T25, `docs/security/findings.md` |
| CH8-S-4 | Fixed: the action is cloned per run, and timed seeds are apart from the warm-up's. | `cpu.ts` |
| CH8-S2-1 | Fixed: lint tests pin `Atomics`, `SharedArrayBuffer`, `Worker` and `WebAssembly` off the engine allow-list, which the CPU-time clock relies on; stated in 02 §6.6 and T25. | `packages/testkit/src/eslint-engine.ts`, `eslint-engine.test.ts` |
| CH8-S2-2, CH8-S2-3 | Fixed in the spec: the calling thread only, and the kernel's resolution. | 02 §6.6, 08 T25, `docs/deploy.md` |
| CH8-P-1, CH8-P-3, CH8-P2-3 to CH8-P2-5 | Fixed: naming, a virtual clock for exact tests, wrapping, older-Node gating. | `cpu.ts`, `kit.test.ts`, `cpu-clock.test.ts` |
| CH8-P-2, CH8-P-4, CH8-P2-6 | No change needed. | — |
| CH8-P2-1, CH8-P2-2 | Resolved at merge with chores 9's runner wording. | `docs/deploy.md`, 08 T25 |

After sign-off, the MR pipeline (82898) found that the testkit tests assumed the 5 ms reference budget, while CI sets `KIT_CPU_BUDGET_MS`; alpha chores 11 names it in the tests.

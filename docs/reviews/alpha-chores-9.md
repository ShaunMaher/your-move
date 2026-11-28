# Alpha chores 9 review: resolutions

This record covers the review of `alpha-chores-9`: the workerd tests (the Worker contract suite,
the D1 repository contract suite and the gmail redirect test) back in the amd64 `test` job now that
the shared runner's VM offers x86-64-v2, and the arm64 `test:worker` job removed (spec v0.9.45). It
had one round of the picky review (CH9-P) and of the security review (CH9-S, info only); the owner
read the fixes and signed off. The MR pipeline is the proof that workerd starts on the runner.

| ID | Outcome | Where |
|---|---|---|
| CH9-P-1 | Fixed. `test` has a measured 40-minute timeout, recorded in docs/deploy.md. | `.gitlab-ci.yml`, `docs/deploy.md` |
| CH9-P-2 | Fixed. `test` fails at once, naming the cause, on a runner without SSE4.2. | `.gitlab-ci.yml` |
| CH9-P-3, CH9-S-1, CH9-S-2 | Fixed. Stale runner wording in 08 T25 and docs/deploy.md, singulars, grammar; `KIT_CPU_BUDGET_MS` kept at 20 after re-measuring (the runner's speed didn't change). | 08 T25, `docs/deploy.md`, ADR 0006, `.gitlab-ci.yml` |
| CH9-P-4 | Fixed. `test:timing` writes the arm64 caches even when it fails. | `.gitlab-ci.yml` |

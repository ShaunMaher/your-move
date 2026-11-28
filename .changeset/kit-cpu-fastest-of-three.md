---
"@your-move/testkit": patch
---

The CPU budget check times each sample as the fastest of three back-to-back runs of `validate` +
`preview` + `apply` on fresh copies of the state, so a run the host preempted or paused for garbage
collection no longer fails a module that is well within budget, while code that is slow on every
call still fails (02 §6.6, 08 T25). The 99th-percentile rule, its allowance, the warm-up and the
budget are unchanged; a sample's later runs are skipped once one is within budget, which doesn't
change the result. The failure message now counts samples over budget and gives the slowest one.

---
"@your-move/testkit": patch
---

The CPU budget check times each sample as the median of five back-to-back runs of `validate` +
`preview` + `apply` on fresh copies of the state and the action, so a run or two the host preempted
or paused for garbage collection no longer fail a module that is well within budget, while code
slow on most calls still fails (02 §6.6, 08 T25). The timed runs no longer reuse the warm-up runs'
random seeds. The 99th-percentile rule, its allowance, the warm-up and the budget are unchanged. A
sample stops once three of its runs are on the same side of the budget; for a module whose cost
doesn't depend on earlier calls, that doesn't change the result. The failure message now counts
samples over budget and gives a lower bound on the slowest one.

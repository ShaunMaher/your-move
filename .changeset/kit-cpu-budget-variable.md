---
"@your-move/testkit": minor
---

`runKit` reads its CPU budget from the `KIT_CPU_BUDGET_MS` environment variable when no
`cpuBudgetMs` option is given, so one setting calibrates every kit run on a slow CI runner; without
it the budget stays 5 ms (02 §6.6, 08 T25). The variable (and `games:verify --cpu-budget-ms`) must
be a whole number of milliseconds from 1 to 50; an unusable value fails the run. New exports:
`readCpuBudget`, `CPU_BUDGET_VARIABLE`, `DEFAULT_CPU_BUDGET_MS`, `MAX_CPU_BUDGET_MS` and the
`CpuBudget` type.

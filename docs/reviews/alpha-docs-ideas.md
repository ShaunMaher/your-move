# Alpha docs: game ideas and the household-profiles proposal: resolutions

This record covers the review of `alpha-docs-ideas`: later candidate games (pairs, a grid race
played in rounds where every seat acts, and others) and a household-profiles proposal for M7, all
recorded as ideas, not committed scope. It had two rounds of the picky review (DI-P, DI-P2); the
owner applied the last nits and signed off. No security review: the change is roadmap ideas only,
and the proposal's security points are listed in it for the M7 privacy review.

| ID | Outcome | Where |
|---|---|---|
| DI-P-1 | Fixed. Pairs records name positions only; matches and faces reach players through `view`. | 10 §Later |
| DI-P-2 | Fixed. A grid-race call's grid is checked in `validate`. | 10 §Later |
| DI-P-3 | Fixed. The timeout gap is stated as a change to 02 §4; the round deadline comes from the seats' clocks. | 10 §Later |
| DI-P-4, DI-P2-2 | Fixed. Calls apply in action order; the remaining edge cases are listed as open. | 10 §Later |
| DI-P-5 | Fixed. The sign-in proposal is an alternative to Q20 (b), with its open points against 06 §3. | 10 §M7 |
| DI-P-6, DI-P2-3 | Fixed. Proposals read as proposals; M7 points at the proposal. | 10 §Later, §M7 |
| DI-P-7 | Fixed. Our own action names, lineage marked. | 10 §Later |
| DI-P-8, DI-P2-1 | Fixed. When the previous turn's faces go, a seat leaving mid-turn, and 3+ seats. | 10 §Later |

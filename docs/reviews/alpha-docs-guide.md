# Alpha docs: the writing-a-game guide after `paths`: resolutions

This record covers the review of `alpha-docs-guide`: the writing-a-game guide revised with what building `paths` taught (10 §M5's guide item). It had one round of the picky review (DG-P), which checked every new claim against the code and spec. The owner signed it off. There's no security review: the change is documentation only, and its security statements link the spec (02 §6.6, 08 T25).

| ID | Outcome | Where |
|---|---|---|
| DG-P-1, DG-P-2 | Fixed. Touch targets are described as `paths` actually sizes them: buttons in rem, squares and hand tiles shrinking on small screens. | `docs/guides/writing-a-game.md` |
| DG-P-3 | Fixed. The `perturbHidden` advice names the states the reference test covers. | guide |
| DG-P-4 | Fixed. Re-wrapped; it cites the paths spec's step 4 and links the file. | guide |
| DG-P-5, DG-P-6 | Fixed. Links to 02 §6.6 and 02 §3 instead of restating them. | guide |

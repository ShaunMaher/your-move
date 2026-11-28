# Alpha A14 review: resolutions

This record covers the review of alpha slice A14, the words board's no-play hint, with the shell
handing the board the game's public word list (`alpha-a14-nomoves`): two rounds of the picky
review (A14-P, then A14-R2) and two of the security review (A14-S, then A14-S2). Each line gives
the finding's ID, its outcome and where the fix lives.

The brief assumed the client already read the downloaded word list; it didn't (07 §4 recorded the
gap). The slice therefore also adds `BoardProps.resources` (02 §3), the hand-over its M3 plan
named, for public lists only.

## Picky review

| ID | Outcome | Where |
|---|---|---|
| A14-P-1 | Fixed. The search keeps its place on an explicit stack, so a slice stops within two steps of its budget anywhere in the search. | `games/words/src/engine/moves.ts`, `moves.test.ts` |
| A14-P-2 | Fixed. The hint waits while a tile is pressed or dragged. | `games/words/src/client/hint.ts`, `Board.tsx`, `Board.test.tsx`, words §10.8, 07 §2 |
| A14-P-3 | Fixed. Tests for a new version, and for leaving the board, in the middle of a search. | `games/words/src/client/Board.test.tsx` |
| A14-P-4, A14-P-5 | Fixed. The search restarts only for a new version or rack, and a failure to start it counts as unknown. | `games/words/src/client/hint.ts` |
| A14-P-6, A14-P-7 | Fixed. One path opens a list; opened lists are kept per page (the three most recently used) and hashed once. | `apps/web/src/word-lists.ts`, tests |
| A14-P-8, A14-P-9 | Fixed. The benchmark records its times without asserting on them; the documentation says lists hold a–z words only and a board treats any other as no list. | `moves.benchmark.test.ts`, `packages/dictionary/src/lookup.ts`, `packages/sdk/src/client.ts`, 02 §3 |
| A14-R2-1 | Fixed. A search gives the same answer, play and step count in one go and in slices of any size, on real boards and in the brute-force property. | `games/words/src/engine/moves.test.ts` |
| A14-R2-2 | Fixed. Tests that the engine's own check never refuses a play the search found. | `games/words/src/engine/moves.ts`, `moves.test.ts` |
| A14-R2-3, A14-R2-4 | Fixed. The kept lists are the most recently used; the spec says "pressed or dragged". | `apps/web/src/word-lists.ts`, words §10.8, 07 §2 |

## Security review

| ID | Outcome | Where |
|---|---|---|
| A14-S-1 | Fixed. The prefix lookup always moves forward, whatever the text, and a list is format-checked before any board gets it. | `packages/dictionary/src/lookup.ts`, `apps/web/src/word-lists.ts`, tests |
| A14-S-2 | Fixed with A14-P-1. | as above |
| A14-S-3 | Fixed. A stored list that no longer matches its hash is deleted and downloaded once more. | `apps/web/src/word-lists.ts`, tests |
| A14-S-4 | Recorded as a decision: the hint is on in every game, as it uses only the viewer's own rack and public data, and it never shows the play it found. The rules text says so. | words §10.8, `games/words/src/client/hint.ts` |
| A14-S-5 | Fixed. The list is chosen by its kind, not its position. | `apps/web/src/word-lists.ts` |
| A14-S2-1 | Fixed. Only a list that passes both checks is stored. | `apps/web/src/word-lists.ts`, tests |
| A14-S2-2 | Fixed with A14-R2-3. | as above |

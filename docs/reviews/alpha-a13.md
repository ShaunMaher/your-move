# Alpha A13 review: resolutions

This record covers the review of alpha slice A13, a tile dragged off the words board returns to
the rack (`alpha-a13-drag`): two rounds of the picky review (A13-P, then A13-R2) and the security
review (A13-S). Each line gives the finding's ID, its outcome and where the fix lives.

## Picky review

| ID | Outcome | Where |
|---|---|---|
| A13-P-1 | Fixed. A cancelled pointer returns the tile only when the ghost showed it was off the board; cancelled over the board, the tile stays on its square. Test for a cancel over the board. | `games/words/src/client/Board.tsx`, `gestures.test.tsx`, 07 §2 |
| A13-P-2 | Fixed. A drop is judged where the pointer was released. | `games/words/src/client/Board.tsx`, `gestures.test.tsx` |
| A13-P-3 | Fixed. A repeated, identical return is announced again. | `games/words/src/client/Board.tsx`, `gestures.test.tsx` |
| A13-P-4 | Fixed. The return and its announcement read the board as it is when the tile is released; nothing happens if a new game version took the square. | `games/words/src/client/Board.tsx` |
| A13-P-5 | Fixed. Tests at the board's edge, a drop on another placed tile, a second pointer and a returned blank. | `games/words/src/client/gestures.test.tsx`, `Board.test.tsx` |
| A13-P-6, A13-P-7 | Fixed. Roadmap row order; the end-to-end step's comment and assertion. | 10, `tests/e2e/src/game.spec.ts` |
| A13-R2-1 | Fixed. Test that a new version taking the dragged tile's square mid-drag moves and announces nothing. | `games/words/src/client/Board.test.tsx` |

## Security review

The security review found nothing above information level.

| ID | Outcome | Where |
|---|---|---|
| A13-S-1 | Fixed. The off-turn test asserts no preview or play request is made. | `games/words/src/client/Board.test.tsx` |
| A13-S-2 | Fixed with A13-P-4. | as above |

# Alpha A12 review: resolutions

This record covers the review of alpha slice A12, past opponents picked from the list
(`alpha-a12-opponents`): three rounds of the picky review (A12-P, then A12-R2) and the security
review (A12-S, then A12-S2). Each line gives the finding's ID, its outcome and where the fix lives.
The spec changes are folded into v0.9.27 (the README history line).

## Picky review

| ID | Outcome | Where |
|---|---|---|
| A12-P-1 | Fixed. A failure in the start at creation is logged by error class only; the request still answers 201 with the stored lobby and the push is still sent. Test with a throwing transition. | `packages/server/src/games/routes.ts`, `apps/node/src/push.test.ts` |
| A12-P-2 | Fixed. Tests for a block between the creator and a typed address (both ways) and between two typed addresses, each answered like a control. | `apps/node/src/opponents.test.ts` |
| A12-P-3 | Fixed. A stored `whoCanAddMe` of `nobody` makes a pick an invitation. | `packages/server/src/games/settings.ts`, `create.ts`, tests |
| A12-P-4 | Fixed. Any joined player other than the creator sees Decline in a lobby. | `apps/web/src/screens/Lobby.tsx`, `Game.test.tsx`, 07 §1.1 |
| A12-P-5 | Fixed. Each past opponent is listed with the date you last played. | `apps/web/src/screens/NewGame.tsx`, 07 §1.1 |
| A12-P-6 | Reverted after round 2 (see A12-R2-1). The pair count stays as joined rows plus picked invitations; the small undercount it leaves is documented and bounded by the daily pair limit. | 05 `TOO_MANY_GAMES` |
| A12-P-7 | Fixed. Q29 records the options for a block between two picked opponents and the default; an M4 acceptance item closes it before blocks can be written. | `docs/spec/open-questions.md`, 06 §6.1, 10 M4 |
| A12-P-8 | Fixed. The roadmap row says blocks are read at creation only. | 10 |
| A12-P-9 | Fixed. ADR 0004 lists the rematch test's budget, to be re-measured on CI. | `docs/adr/0004-measured-time-budgets-for-slow-test-infrastructure.md` |
| A12-P-10 – P-13 | Fixed. An empty email field goes first when a pick takes a seat; a renamed variable; a note when every seat is filled. | `apps/web/src/screens/NewGame.tsx`, `text.ts` |
| A12-R2-1 | Fixed. The (creator, `userId`) count is back to joined rows and picked invitations, so a typed address's row is never counted for the person it resolves to. Contract cases on both adapters: a typed row dropped at a start, or declined in a lobby that stays open, counts 0. | `packages/server/src/db/repos.ts`, `repository-contract.ts`, 05 |
| A12-R2-2 | Fixed. The name and the date are separated for screen readers. | `apps/web/src/screens/NewGame.tsx` |
| A12-R2-3 | Fixed. 07 says Decline shows for any joined player other than the creator. | 07 §1.1 |

## Security review

| ID | Outcome | Where |
|---|---|---|
| A12-S-1 | Accepted risk F-19 until M4 (the `whoCanAddMe` setting and Block). | `docs/security/findings.md`, 08 T20 |
| A12-S-2 | Open, not reachable until blocks can be written: Q29, default (e), and an M4 acceptance item. | `docs/spec/open-questions.md`, 10 M4 |
| A12-S-3 | Fixed. Tests pin that no write clears a typed invitation's address while its lobby is open; an explicit pick marker is named for M4. | `packages/server/src/games/units.test.ts`, `repository-contract.ts`, 10 M4 |
| A12-S-4 | Fixed. The "added you" push goes only to players still in a live game. | `packages/server/src/push/notify.ts`, tests |
| A12-S2-1 | Fixed (the same as A12-R2-1). | as above |
| A12-S2-2 | Recorded as a decision: a creator sees a `nobody` pick as invited, which shows that person's general preference and nothing else. | 06 §6.2 |

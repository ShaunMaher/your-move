# Alpha A23 review (blocking): resolutions

This record covers the review of `alpha-a23-blocks`: the blocks API and UI, a block's effect on lobbies, the block checks on accept and Start, and Q29 settled as option (e) (spec v0.9.44). It had two rounds of the picky review (A23-P, A23-P2) and of the security review (A23-S, A23-S2). Two round-1 security fixes didn't hold, so the owner made an exception to the two-round cap for security correctness: a targeted third round and a focused security check (A23-S3), whose last fixes the owner verified and signed off.

Owner decisions:
- invitations go `inert` rather than being refused at accept (S-2);
- outstanding effects are their own transition, with the trigger answering `STALE_GAME` (S-3, S2-3);
- the flip applies only where the blocker has joined, and again when they join (P2-2, S3-1);
- F-26 accepted (S-5).

| ID | Outcome | Where |
|---|---|---|
| A23-S-1, A23-S2-1, A23-S2-2 | Fixed. Eligibility counts only past opponents, existing blocks and joined rows; probes of typed addresses, open or ended, get the stranger's `404`. | `packages/server/src/db/auth-repos.ts`, 05 §Blocks |
| A23-S-2, A23-P2-2, A23-S3-1 | Fixed (owner decisions). The blocked person's open invitations go `inert`, versionless, in lobbies the blocker has joined, at the block and when the blocker later joins. | `auth-repos.ts`, `packages/server/src/db/queries/transition.ts`, 04, 06 §6.10 |
| A23-S-3, A23-S2-3, A23-P2-3, A23-S3-4 | Fixed (owner decision). An outstanding effect is the blocker's Decline or the creator's Remove, written as its own transition. The triggering Start or accept answers `STALE_GAME`. It fails closed. | `packages/server/src/games/lifecycle.ts`, `routes.ts`, 02 §4 |
| A23-S-4, A23-P-6 | Fixed. A no-block guard in the accept and link-join writes. | `transition.ts`, `join-routes.ts` |
| A23-S-5, A23-S-6, A23-S2-5, A23-S3-2 | Accepted: F-26. | `docs/security/findings.md`, 08 T4, T20 |
| A23-S-7, A23-S-8 | Fixed in 06 §6.11 and 09 §3. | 06, 09 |
| A23-S2-4, A23-S3-3 | Noted: nothing leaks. | — |
| A23-P2-1 | Fixed. 03 §5.2 lists the versionless `inert` writes, including the under-age exit's, which alpha A21 had left out. | 03 §5.2 |
| A23-P-1 | Fixed. Joined non-creators, including those auto-joined, can block the creator. | `apps/web/src/screens/Lobby.tsx`, 07 §1 |
| A23-P-2 | Fixed. The dialog says what a block does without saying whose row is whose. | `Lobby.tsx`, 07 |
| A23-P-3 to A23-P-5, A23-P2-4, A23-P2-6, A23-P2-8, A23-P2-10, A23-P2-12 | Fixed. Spec wording. | 04, 05, 06 |
| A23-P-7, A23-P-8, A23-P2-5, A23-P2-7 | Fixed. Missing tests and assertions. | `apps/node/src/blocks.test.ts`, `opponents.test.ts`, `push.test.ts`, `present.test.ts` |
| A23-P-9 | Fixed. Blocks are read only for accept and Start. | `routes.ts` |
| A23-P-10, A23-P-11, A23-P-14 | Fixed. Doc and comment fixes. | 09 §3, 10, tests |
| A23-P-12, A23-P-13, A23-P2-11 | Fixed. Focus, status and labels in the UI. | `apps/web/src/screens/BlockedPlayers.tsx`, `Lobby.tsx` |
| A23-P-15 | Fixed. One shared error-responses helper. | `packages/shared/src/error-responses.ts` |
| A23-P-16 | Fixed. Exhaustion logged; uninstalled games left out of `blockableLobbies`. | `block-routes.ts` |
| A23-P2-9 | Fixed. The cast removed. | `routes.ts` |

# Alpha A19 review ("Add <name> to your players?"): resolutions

This record covers the review of `alpha-a19-add-player`: the finished-screen question that adds a
game's link joiners to the creator's players, so Rematch works after a link game (spec v0.9.36).
It had two rounds of the picky review (A19-P, A19-P2) and of the security review (A19-S,
A19-S2); the owner read the last fixes and signed off. One owner decision settled A19-P-6 against
A19-S-1: everyone the creator can't actually add stays listed and gets the same silent `204`.

| ID | Outcome | Where |
|---|---|---|
| A19-S-1, A19-P-6 | Fixed (owner decision). The write also skips suspended accounts; a block, a suspension and a deletion all stay listed with the same silent `204`, and the confirmation shows regardless (recorded in 08 T20). | `packages/server/src/db/auth-repos.ts`, 05, 06 §6.11, 08 T20 |
| A19-S-2 | Recorded for M4: `add-player` is gated like game creation once onboarding re-prompts exist. | 05, 10 §M4 |
| A19-S-3 | Fixed. The write requires both accounts to be human. | `packages/server/src/db/auth-repos.ts` |
| A19-S-4 | Fixed. One rule (`addableUserIds`) decides both the list and whom the route accepts; a deleted joiner gets the same `404`. | `packages/server/src/games/present.ts`, `routes.ts` |
| A19-P-1 | Fixed. The line under Rematch names only the people still asked; Not now silences it until a refused Rematch brings the question back. | `apps/web/src/screens/Frame.tsx`, 07 §1 |
| A19-P-2, A19-P2-1 | Fixed. A non-creator refused a rematch is told to ask the creator by name, or "the game's creator" when there is none. | `Frame.tsx`, `game-text.ts` |
| A19-P-3 | Fixed in the spec: only the creator starts a rematch of a link game; tested. | 06 §6.11, `apps/node/src/add-player.test.ts` |
| A19-P-4 | Fixed. Each button names its person; the status region stays mounted. | `Frame.tsx` |
| A19-P-5 | Fixed. Route tests for an existing pair (later time kept), an active game and a deleted joiner. | `apps/node/src/add-player.test.ts` |
| A19-P-7, A19-P2-2 | Fixed. Comments on who checks eligibility and on a joiner deleted between two reads. | `packages/server/src/db/repositories.ts`, `present.ts` |
| A19-P-8 | No change; the e2e follows the suite's conventions. | — |

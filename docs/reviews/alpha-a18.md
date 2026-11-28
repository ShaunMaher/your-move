# Alpha A18 review (join links and remove seat): resolutions

This record covers the review of `alpha-a18-join-links`: join links and remove seat, pulled
forward from M4 (spec v0.9.35). It had two rounds of the picky review (A18-P, A18-P2) and of the
security review (A18-S, A18-S2); the owner read the last fixes and signed off. One owner
decision changed the spec in round 1: a removal sticks across every join link (A18-S-3).

| ID | Outcome | Where |
|---|---|---|
| A18-S-1 | Fixed. Deleting an account deletes the join links of the lobbies it created, and a join to a game whose creator row has no user gets the same 404. | `packages/server/src/db/auth-repos.ts`, `games/join-links.ts`, 04 §Account deletion |
| A18-S-2 | Fixed in wording; residual F-23. The page clears the token from the tab's session history; the browser's own history database is out of reach. | 06 §6.8, 08 T24, `docs/security/findings.md` |
| A18-S-3 | Changed (owner decision). A removed row never comes back through any join link; the creator can play with them in another game. | 02 §4, 04, 05, 06 §6.8, 08, `games/lifecycle.ts`, `games/join-routes.ts` |
| A18-S-4 | Accepted residual, recorded in 08 T24 and T20. | 08 |
| A18-S-5 | Deferred to AI accounts (M8): the lookup's `aiOwnerName`. | 10 §M8 |
| A18-S-6 | Fixed. "Not now" and "Open the game" clear the kept token. | `apps/web/src/screens/Join.tsx` |
| A18-S-7 | Fixed. A token must be 22 base64url characters (400 otherwise); any well-formed token that isn't a live link's gets the one 404. | `packages/shared/src/games.ts`, 05 |
| A18-S2-1 | Commented. The creator's daily link cap is approximate under concurrent requests from the same creator; each request only rewrites that game's one link row. | `packages/server/src/games/join-routes.ts` |
| A18-S2-2 | Fixed. The identical-404 test has a deleted-creator arm. | `apps/node/src/join-links.test.ts` |
| A18-P-1 | Fixed. A link is asked for only while a seat is left for it. | `apps/web/src/screens/NewGame.tsx` |
| A18-P-2 | Fixed. One accept set-builder for both paths; `delivery` only counts toward unread while the row is an open invitation. | `games/lifecycle.ts`, `games/routes.ts` |
| A18-P-3, A18-P-4 | Fixed in the spec: the A17 roadmap row, and auto-start judged only in an accept transition. | 10, 06 §6.8 |
| A18-P-5 | Fixed. Retries running out, join against rotate and revoke, and accept against remove, on both adapters. | `packages/server/src/testing/race-contract.ts`, `apps/node/src/join-links.test.ts` |
| A18-P-6 | Partly: the landing page shows the turn order; an options summary waits for one to exist (07). | `apps/web/src/screens/Join.tsx`, 07 |
| A18-P-7 | Fixed. The lookup's optional `youAreIn` shows "You're in this game" with Open. | 05, `Join.tsx` |
| A18-P-8 | Fixed. Making a new link or turning it off asks first while a link works. | `apps/web/src/screens/JoinLinkPanel.tsx` |
| A18-P-9 | Fixed. "3 of 4 joined: you can start now, or wait for more", from the envelope's new optional `seats`. | `apps/web/src/screens/Lobby.tsx`, SDK, 05 |
| A18-P-10 | Fixed: the link count after the write, 05's tables, one server retry constant, a bounded sweep step, shared helpers, the join routes in their own module. | various |
| A18-P2-1, A18-P2-2 | Fixed. The Remove dialog and the API description state the sticky removal. | `Lobby.tsx`, `packages/shared/src/games.ts`, generated client |
| A18-P2-3 | Fixed in the spec: no promise of adding invitees to an existing lobby. | 02 §4, 06 §6.8 |
| A18-P2-4, A18-P2-5 | Fixed. The rematch accept uses the server retry constant; 05 counts every call that passes validation. | `games/routes.ts`, 05 |

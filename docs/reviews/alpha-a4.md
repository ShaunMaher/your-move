# Alpha A4 review — resolutions

This record covers round 1 of the review of alpha slice A4, the shell UI (`alpha-a4-shell`): the
picky review (A4-P) and the security review (A4-S), plus one change in the words package
(A4-A3-1). Each line gives the finding's ID, its outcome and where the fix lives. The spec changes
are in v0.9.17 (the README history line).

## Picky review (A4-P)

| ID | Outcome | Where |
|---|---|---|
| A4-P-1 | Fixed. While a board is on screen the board draws the scores and whose turn it is and the shell draws neither: no player chips, no turn line, no second live region (the shell's one `role=status` now carries only the offline or server-trouble notice). The chips and a plain, non-live turn line stand in only when no board can be shown. "Game over" is gone from the turn line; a finished game is the Final result card alone, with the reason. The board sits above the fold on a phone (screenshots `game-in-progress.png`; a 320 px width was not separately screenshotted). 02 §3 says who draws what. Tests: no chips, `.turn` or extra live region beside a board; the stand-in is not live; a finished game has no "Game over" or chips. | `apps/web/src/screens/Frame.tsx`, `Game.tsx`, `Game.test.tsx`, 02 §3 |
| A4-P-2 | Fixed. Tab and Shift-Tab wrap (tests), the focusable set covers links, buttons, inputs, selects, textareas, summaries and `tabindex` elements and drops disabled, hidden and inert ones, the rest of the page is `inert` while a dialog is open (the dialog renders into its own container on `body`) and is restored on close, and a tap on the backdrop closes it (a press that began inside the sheet doesn't). | `apps/web/src/Dialog.tsx`, `Dialog.test.tsx` |
| A4-P-3 | Fixed, with one tracked gap. The comment and 07 §4 say "most recently added" (Cache Storage's key order); overlapping calls run one at a time; the lists of the game being opened are never evicted for it (tests: a four-list game keeps all four, then the next game's list evicts the oldest, and overlapping calls). Tracked gap, recorded in 07 §4: no preview reads the cache yet; a `resources` prop on `BoardProps` is a spec change for M3. | `apps/web/src/word-lists.ts`, `word-lists.test.ts`, 07 §4 |
| A4-P-4 | Fixed. A refetch asked for because the game moved on (`STALE_GAME`, `NOT_YOUR_TURN`, `GAME_NOT_ACTIVE`, `WRONG_STATUS`, and now `GAME_UNAVAILABLE`) while one is in flight queues one more, run when the first ends; polls and focus events are still dropped. Test: a stale move refused during a focus refetch ends on the newest game, after three fetches (fails with the queue removed). | `apps/web/src/screens/Game.tsx`, `Game.test.tsx` |
| A4-P-5 | Fixed. A client module that loads for a game no longer chosen is ignored. Test fails before the fix. | `apps/web/src/screens/NewGame.tsx`, `NewGame.test.tsx` |
| A4-P-6 | Fixed. The list polls every 15 s while visible, whether or not anything is waiting. A refresh after "Show more" keeps the older pages already shown instead of collapsing the list. Test: a new invitation appears with nothing waiting. | `apps/web/src/screens/GameList.tsx`, `GameList.test.tsx` |
| A4-P-7 | Fixed. Tests added: hidden tab polls nothing (game and list), nothing is marked seen while hidden, a lobby is not marked seen, a late older answer never replaces a newer one, and a `5xx` on a ready game shows "The server isn't answering right now. We'll keep trying." and clears on the next good answer (the screen used to stay silent). | `Game.test.tsx`, `GameList.test.tsx`, `Game.tsx` |
| A4-P-8 | Fixed. The test reads both players' scores from the board's score bar and requires both above zero; the loop is bounded by rounds and by a 60 s loop budget, so a stuck game fails an assertion rather than the test timeout. The test reads whose turn it is from the board's score bar now that the shell's turn line is gone. | `tests/e2e/src/game.spec.ts`, `budgets.ts` |
| A4-P-9 | Fixed. The budget comment is rewritten; the short resign test has its own 60 s (`RESIGN_TEST_TIMEOUT_MS`) and the moves loop 60 s. ADR 0004's "Tests keep 30 s" line names the game-test exception. Local measurements, the pinned image with a warm browser: the full game 19 to 22 s (both projects), the resign test 2 to 3 s. The 120 s is still a margin, not a CI measurement: **to be re-measured on the CI runner from the first pipeline that runs it; the owner feeds the number back** and `GAME_TEST_TIMEOUT_MS` and the ADR are then set from it. | `tests/e2e/src/budgets.ts`, ADR 0004 |
| A4-P-10 | Fixed. 02 §3 and §7 say a game takes Zod only as the peer dependency, because the web app runs it `jitless` and a game's own copy or compiled parser would need `unsafe-eval`. No `games:verify` check (optional). | 02 §3, §7 |
| A4-P-11 | Fixed, one part rebutted. Rebutted: the drawer does not show the stored `describe` text beside the module's rendering. It passes `describe` to the module's `HistoryItem` as the contract says (02 §3), and the words `HistoryItem` uses it only for a record or version it can't draw. The test module that prints both does so on purpose, to show what it was given. 02 §3 now says the shell shows nothing else. Fixed: the drawer scrolls to the newest entry when it opens (oldest first is kept, the list is labelled so); `markSeen` is skipped from a hidden tab and for lobbies (tests); `GAME_UNAVAILABLE` on resign says "This game is no longer available." (test). | `History.tsx`, `Game.tsx`, 02 §3 |
| A4-P-12 | Fixed. State is no longer set after an await once the screen is gone (game and list). | `Game.tsx`, `GameList.tsx` |
| A4-P-13 | Checked. The one sort (the results card) sorts a fresh `filter` copy, so `toSorted` would change nothing; no change. The copy "a typo just means an invitation nobody receives" is true for the alpha: an unknown address's seat is never claimed and the lobby expires; left as is. | `NewGame.tsx` |

## Security review (A4-S)

| ID | Outcome | Where |
|---|---|---|
| A4-S-1 | Fixed. A list is fetched only when its resource says `distribution: "public"`; a resource with a URL and no distribution is skipped (test); the fetch uses `credentials: "omit"` and `redirect: "error"` (test). | `apps/web/src/word-lists.ts`, `word-lists.test.ts` |
| A4-S-2 | Fixed. For both players of the game test, no `/api/` response comes from the worker, and Cache Storage is the precache list plus only `dictionaries-v1` entries of the shape `/assets/dictionaries/<id>-v<n>.<16 hex>.txt`. 07 §4 states it so. | `tests/e2e/src/game.spec.ts`, `helpers.ts`, 07 §4 |
| A4-S-3 | Done. 06 §4 says the public word-list cache deliberately survives sign-out. | 06 §4 |
| A4-S-4 | Done. 08 §3 says the web app runs Zod `jitless` and must never need `unsafe-eval`. | 08 §3 |
| A4-S-5 | Done. 07 §4 gives the alpha poll rates: visible tabs only, an open game every 5 s while it waits, the list every 15 s. | 07 §4 |

## Words board (A4-A3-1)

| ID | Outcome | Where |
|---|---|---|
| A4-A3-1 | Fixed. axe's `label-content-name-mismatch` (WCAG 2.5.3) rejected the board: a premium square's face reads "3W" while its name said "triple word", and a tile's face reads "A1" while its name said "A, 1 point". A premium square's name now starts with its face text ("Row 1, column 3, 3W, triple word, empty") and a tile's face has a space between letter and points (not drawn: the tile is a flex box) so it reads "A 1". Tests: every square's name contains its face text, and every tile's. The e2e skip (`BOARD_LABELS`) is removed. | `games/words/src/client/BoardGrid.tsx`, `Tile.tsx`, `Board.test.tsx`, `tests/e2e/src/game.spec.ts` |

## Hidden invitations (A4-A2-1)

| ID | Outcome | Where |
|---|---|---|
| A4-A2-1 | Done (owner addition, from the A2 security review). The game list has a collapsed "Hidden invitations" section, shown only when there are any, fetched apart with `?invitations=hidden` (06 §6.7, 07 §1), with the line "Invitations from people you haven't played before, over the daily limit" and rows that open the lobby, where Accept and Decline work as for normal invitations. A hidden invitation has no badge (the "Invitation" badge is for `yourInvitation: "normal"` only). The generated client on this branch already types the `invitations: "true" \| "hidden"` query, so no string workaround was needed. Only the first page (50) is fetched; no "show more" for hidden ones. Tests: the section is collapsed, explained, badge-free, links to the lobby, is not among the invitations, and is absent when empty. | `apps/web/src/screens/GameList.tsx`, `game-api.ts`, `GameList.test.tsx`, `test-support.ts` |

## Round 2

| ID | Outcome | Where |
|---|---|---|
| A4-R2-1 | Fixed. `Dialog` takes `dismissible` (default true); the resign and lobby-cancel dialogs pass `false` while their request is pending, so Escape and a backdrop tap do nothing, and "Keep playing" / "Keep it" are disabled. A failure shows when the request ends (resign: in the dialog, which stays; cancel: on the lobby page, as before). Tests (fail before the fix): a held resign request survives backdrop, Escape and the keep button, then a failure is shown and the dialog can be dismissed again; the same for a held cancel; `Dialog` ignores Escape and backdrop taps when not dismissible. | `apps/web/src/Dialog.tsx`, `screens/Frame.tsx`, `screens/Lobby.tsx`, `Dialog.test.tsx`, `screens/Game.test.tsx` |
| A4-R2-2 | Fixed. The opener is read in a `useState` initialiser, before the page is made inert (inerting blurs the focused element). `Frame.close()` no longer focuses the Menu button while the page is still inert; it sets a flag and an effect focuses the button once the dialog has gone. e2e on both projects: Menu has focus after Escape closes History and after "Keep playing". | `Dialog.tsx`, `Frame.tsx`, `tests/e2e/src/game.spec.ts` |
| A4-R2-3 | Fixed. The score poll waits for `scores.length === 2 && every > 0`. | `tests/e2e/src/game.spec.ts` |
| A4-R2-4 | Fixed. After the game `dictionaries-v1` must hold at least one entry (both players). Positive control: `watchWorkerResponses` now returns `{ api, assets }` and each player must have at least one non-API response from the worker; Playwright reports `fromServiceWorker()` on both WebKit and Chromium here, so the control runs on both projects. | `tests/e2e/src/helpers.ts`, `game.spec.ts` |
| A4-R2-5 | Fixed. 02 §3: the Results card owns ranks and how the game ended; the board's final summary is the module's breakdown (scores, adjustments, racks). The card lists scores only when no board is drawn, so a score is not shown twice. Module contract unchanged. Tests: the card's rows are rank and name beside a board; scores show when none is drawn. The words board's own "how it ended" line is kept (it names who). | `docs/spec/02-game-framework.md`, `screens/Frame.tsx`, `Game.test.tsx` |
| A4-R2-6 | Fixed with a test. e2e at 320x568: scroll is 0 and both the board and its first square start above 568 px. | `tests/e2e/src/game.spec.ts` |
| A4-R2-7 | Fixed. Each hidden-invitations request carries a sequence number and only the newest answer is applied. Test (fails before the fix): a slow older answer arriving after a newer one is dropped. | `screens/GameList.tsx`, `GameList.test.tsx` |
| A4-R2-8 | Fixed. `running = run.catch(() => undefined)` (test: a call that rejects outright doesn't stop the next; fails before); the hidden section reads "50+" when the server says there is another page (test); the focus trap leaves out elements inside a closed `<details>`, keeping its summary (test, fails before). | `word-lists.ts`, `GameList.tsx`, `Dialog.tsx` and their tests |

# Alpha A7 review — resolutions

This record covers rounds 1 and 2 of the review of alpha slice A7, the "Add to Home Screen" guide
(`alpha-a7-install`): the picky review (A7-P) and the security review (A7-S, information only).
Each line gives the finding's ID, its outcome and where the fix lives. The spec changes are folded
into v0.9.22 (the README history line).

## Picky review (A7-P)

| ID | Outcome | Where |
|---|---|---|
| A7-P-1 | Fixed. The guide says Safari is the most reliable and that other iPhone browsers (iOS 16.4+) may offer Add to Home Screen in their own share menu; the banner stays Safari-only. | `apps/web/src/screens/Install.tsx`, 07 §4 |
| A7-P-2 | Fixed. Step 1 says Share is at the bottom on iPhone and top right on iPad, and to tap the three-dot button first if it isn't shown; the "Open as Web App" note was not actually in step 3 after round 1 and was added in round 2 (A7-P2-1); it now says to leave it on if iOS shows it. | `screens/Install.tsx` |
| A7-P-3 | Fixed. Safari needs `Version/` and `Safari/`; the in-app tokens `Twitter`, `LinkedInApp`, `Snapchat`, `Pinterest`, `MicroMessenger`, `musical_ly`, `BytedanceWebview` and `Reddit` are excluded; `Line` is anchored (`\bLine\/`). | `apps/web/src/install.ts`, 07 §4 |
| A7-P-4 | Fixed. Dismissing moves focus to the screen's `h1`. Test. | `InstallBanner.tsx`, `InstallBanner.test.tsx`, 07 §4 |
| A7-P-5 | Fixed. Tests: a signed-out `/install` lands on `/install` after sign-in; the banner shows on `/new` and `/settings` and not on `/g/:id` or `/welcome`; the Settings link; the user-agent matrix; a Mac with no touch screen. | `InstallBanner.test.tsx` |
| A7-P-6 | Fixed. Round 1 still assigned `window.matchMedia` directly; round 2 (A7-P2-1) stubs it with `vi.stubGlobal`, restored by `vi.unstubAllGlobals`. | `InstallBanner.test.tsx` |
| A7-P-7 | Fixed. "Show me how" is an `a.button` (44 pt target); the shell after a banner drops its full-height minimum, so there is no extra scroll. | `InstallBanner.tsx`, `styles.css` |
| A7-P-8 | Fixed. Every step has a glyph (a tick for Add, a tray arrow for Install app), so the text aligns. | `screens/Install.tsx` |
| A7-P-9 | Fixed. The e2e cold-loads `/install` on both projects and checks the `h1`. | `tests/e2e/src/install.spec.ts` |

## Security review (A7-S, information only)

| ID | Outcome | Where |
|---|---|---|
| A7-S-1 | Fixed. Test: sign-out's `clearClientState()` removes `ym.game.*` keys and keeps `ym.install-dismissed`. | `InstallBanner.test.tsx` |
| A7-S-2 | Fixed (spec). 06 §4 says the flag is per device, carries no user data and survives sign-out on purpose. | 06 §4 |

## Round 2 verification (A7-P2)

| ID | Outcome | Where |
|---|---|---|
| A7-P2-1 | Fixed. Two round 1 rows (P-2, P-6) claimed changes that were not in the code; both are now made and the rows corrected above. | `screens/Install.tsx`, `InstallBanner.test.tsx` |
| A7-P2-2 | Fixed. The test drives the real sign-out button on Settings in `App`, then checks `ym.game.*` is gone and `ym.install-dismissed` kept. | `InstallBanner.test.tsx` |
| A7-P2-3 | Fixed. Every third-party and in-app token (FxiOS, EdgiOS, OPiOS, GSA, DuckDuckGo, Instagram, FBAN/FBAV, Twitter, LinkedInApp, Snapchat, Pinterest, MicroMessenger, musical_ly, BytedanceWebview, Reddit, Line) is appended to a user agent that keeps `Version/` and `Safari/`. Checked by removing tokens from the pattern: the matching cases failed, then the pattern was restored. | `InstallBanner.test.tsx` |
| A7-P2-4 | Fixed. The test is named for what it proves: no banner at a game's address, whether or not the game loads. | `InstallBanner.test.tsx` |
| A7-P2-5 | Fixed. The 07 §4 install paragraphs are wrapped to 100 columns. The README history stays one line, as every entry before it is. | 07 §4, `docs/spec/README.md` |

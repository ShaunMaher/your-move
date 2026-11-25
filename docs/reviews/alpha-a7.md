# Alpha A7 review — resolutions

This record covers round 1 of the review of alpha slice A7, the "Add to Home Screen" guide
(`alpha-a7-install`): the picky review (A7-P) and the security review (A7-S, information only).
Each line gives the finding's ID, its outcome and where the fix lives. The spec changes are folded
into v0.9.22 (the README history line).

## Picky review (A7-P)

| ID | Outcome | Where |
|---|---|---|
| A7-P-1 | Fixed. The guide says Safari is the most reliable and that other iPhone browsers (iOS 16.4+) may offer Add to Home Screen in their own share menu; the banner stays Safari-only. | `apps/web/src/screens/Install.tsx`, 07 §4 |
| A7-P-2 | Fixed. Step 1 says Share is at the bottom on iPhone and top right on iPad, and to tap the three-dot button first if it isn't shown; step 3 says to leave "Open as Web App" on. | `screens/Install.tsx` |
| A7-P-3 | Fixed. Safari needs `Version/` and `Safari/`; the in-app tokens `Twitter`, `LinkedInApp`, `Snapchat`, `Pinterest`, `MicroMessenger`, `musical_ly`, `BytedanceWebview` and `Reddit` are excluded; `Line` is anchored (`\bLine\/`). | `apps/web/src/install.ts`, 07 §4 |
| A7-P-4 | Fixed. Dismissing moves focus to the screen's `h1`. Test. | `InstallBanner.tsx`, `InstallBanner.test.tsx`, 07 §4 |
| A7-P-5 | Fixed. Tests: a signed-out `/install` lands on `/install` after sign-in; the banner shows on `/new` and `/settings` and not on `/g/:id` or `/welcome`; the Settings link; the user-agent matrix; a Mac with no touch screen. | `InstallBanner.test.tsx` |
| A7-P-6 | Fixed. `matchMedia` is stubbed with `vi.stubGlobal` and restored with `vi.unstubAllGlobals`. | `InstallBanner.test.tsx` |
| A7-P-7 | Fixed. "Show me how" is an `a.button` (44 pt target); the shell after a banner drops its full-height minimum, so there is no extra scroll. | `InstallBanner.tsx`, `styles.css` |
| A7-P-8 | Fixed. Every step has a glyph (a tick for Add, a tray arrow for Install app), so the text aligns. | `screens/Install.tsx` |
| A7-P-9 | Fixed. The e2e cold-loads `/install` on both projects and checks the `h1`. | `tests/e2e/src/install.spec.ts` |

## Security review (A7-S, information only)

| ID | Outcome | Where |
|---|---|---|
| A7-S-1 | Fixed. Test: sign-out's `clearClientState()` removes `ym.game.*` keys and keeps `ym.install-dismissed`. | `InstallBanner.test.tsx` |
| A7-S-2 | Fixed (spec). 06 §4 says the flag is per device, carries no user data and survives sign-out on purpose. | 06 §4 |

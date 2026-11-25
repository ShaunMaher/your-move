# Alpha slice A1 (sign-in UI) review — resolutions

This record covers round 1 of the review of alpha slice A1, the sign-in screens and the service
worker (`alpha-a1-signin-ui`): the picky review (P) and the security review (S). Findings that
overlapped were fixed once and share a row. Each line gives the finding's ID, its outcome and
where the fix lives. The spec changes are in the v0.9.17 history line of the README.

| ID | Outcome | Where |
|---|---|---|
| A1-P-1 / A1-S-1 | Fixed. One `useSignOut` hook serves Settings and Welcome: a pending state, and an always-present alert ("Couldn't sign out. You're still signed in. Try again.") for offline, 5xx and 429; only an answer (or a 401) ends the session. Tests for each failure on Settings and for Welcome. | `apps/web/src/use-sign-out.ts`, `screens/Settings.tsx`, `screens/Welcome.tsx`, `App.test.tsx` |
| A1-P-2 | Fixed. The test waits for the logout request, then asserts the error text, no navigation to `/signin`, the Settings heading and a usable button, for three failure kinds. | `apps/web/src/App.test.tsx` |
| A1-P-3 / A1-S-5 | Fixed. 03's technology table, 07 §4 and the `sw-register.ts` comment describe the hand-written worker (no Workbox terms; no runtime caching claimed). | 03 §2 table, 07 §4, `apps/web/src/sw-register.ts` |
| A1-P-4 | Spec version clash: left as is; resolved at merge (the owner renumbers). | README |
| A1-P-5 / A1-S-4 | Fixed. The version hashes the content of every precached file (HTML, public files, hashed assets), computed once the output directory is complete. Tests change each kind of file and expect a new version. | `apps/web/vite-plugin/service-worker.ts`, `vite-plugin/service-worker.test.ts` |
| A1-P-6 / A1-S-2 | Fixed. `SERVER_PATHS` lives in `@your-move/shared` (`server-paths`); the server and the Vite plugin both use it and the plugin injects it into `BUILD`. Unit tests run `sw.js` against stubbed globals (install, fetch filtering, navigation fallback, activate). An e2e test with the worker in charge signs in, loads Settings and signs out, and checks that no `/api/` response came from the worker and that Cache Storage holds exactly the precache list. `run_worker_first` in the Worker's configuration is still edited by hand (said in 07 §4 and the shared module). | `packages/shared/src/server-paths.ts`, `apps/web/sw/sw.js`, `sw/sw.test.ts`, `tests/e2e/src/signin.spec.ts` |
| A1-P-7 | Fixed. A navigation races a 4 s timeout (commented) before the cached shell is shown; with no shell the network alone decides. Tested with fake timers. | `apps/web/sw/sw.js`, 07 §4 |
| A1-P-8 | Fixed by reloading every open tab when the controller changes (a tab that had a controller reloads when another takes over; the first install still does not). Recorded in 07 §4. | `apps/web/src/sw-register.ts`, `sw-register.test.ts`, 07 §4 |
| A1-P-9 | Fixed. A signed-out visit's path is remembered (`sessionStorage`, same-origin absolute paths only, validated on the way in and out) and used after sign-in; an explicit sign-out forgets it. Focus moves to the new screen's `h1` (`tabIndex={-1}`) after a route change, unless the screen focused a field itself. | `apps/web/src/return-path.ts`, `App.tsx`, 07 §1/§6 |
| A1-P-10 | Fixed. The test is renamed to say it checks that the app shows the server's identical answer identically, and says where the server's own parity is tested. | `apps/web/src/App.test.tsx` |
| A1-P-11 | Fixed. The update toast and the "sent another code" notice are always-rendered live regions; the `a { display: inline-flex }` rule now applies only to links in the bar; the Welcome sign-out link has a 44 px target; the toast has room under the page's content while it shows. | `apps/web/src/UpdateToast.tsx`, `screens/SignIn.tsx`, `styles.css` |
| A1-S-3 | Fixed. A `BroadcastChannel` message ends the session in every open tab, a tab that becomes visible checks `/api/v1/me` again, and both go through `clearClientState()`, which also removes every `localStorage` key under the reserved prefix `ym.game.` (owner decision: `ym.game.<gameType>.<userId>.<gameId>`), with try/catch. Unit tests: the prefix is cleared and nothing else, a throwing store is survived, another tab's message and the visibility check sign this tab out. The push unsubscribe and rack order are left for their slices (comment in the function). 06 §4 names the prefix. | `apps/web/src/session-sync.ts`, `App.tsx`, `App.test.tsx`, 06 §4 |
| A1-S-6 | Fixed. A `400` on `/otp/request` after the app's own check passed says "Something went wrong sending your code. Try again later.", the same for every address. | `apps/web/src/screens/SignIn.tsx`, `App.test.tsx` |

## Round 2

| ID | Outcome | Where |
|---|---|---|
| A1-P2-1 | Fixed. The remembered return path is spent only when the screen shown is a real destination (not `/signin` or `/welcome`), so a new person who must onboard still lands where they were headed. Test: a signed-out visit to `/settings`, a new account, Welcome, then Settings. | `apps/web/src/App.tsx`, `return-path.ts` (`isDestination`), `App.test.tsx` |
| A1-P2-2 | Fixed. The unmeasured 20 s web test timeout is removed; the suite runs on Vitest's defaults and passes. | `apps/web/vitest.config.ts` |
| A1-P2-3 | Fixed. The test seeds a remembered path, signs out, signs back in and asserts it lands on `/`. | `apps/web/src/App.test.tsx` |
| A1-P2-4 | Fixed. The header comment says every open tab reloads, the others unasked, and that unsent input in them is lost; 07 §4 states the same cost. | `apps/web/src/sw-register.ts`, 07 §4 |
| A1-P2-5 | Fixed. The blanket `ignoreDependencies` for `@your-move/shared` is gone; knip's `apps/web` entry and project now include `vite-plugin/`, so it sees the import. | `knip.config.ts` |
| A1-P2-6 | Fixed. The version also hashes the worker's own source; a test changes only the template and expects a new version. | `apps/web/vite-plugin/service-worker.ts`, `service-worker.test.ts` |
| A1-P2-7 | Fixed. Rendering no longer reads `sessionStorage`: the remembered path is taken in the sign-in handler and held in the app's state. | `apps/web/src/App.tsx` |
| A1-P2-8 | Acknowledged. The spec version clash is renumbered by the owner at merge, as for A1-P-4. | README |
| A1-S2-1 | Verified. The build plugin now lives in the tracked `apps/web/vite-plugin/`; a fresh clone of the branch installs, builds and passes the web tests (result in the hand-off). | `apps/web/vite-plugin/` |
| A1-S2-2 | Fixed. Whenever `/me` is re-read (the tab becomes visible, or another tab announces a sign-in) an answer with a different user id clears the client state and starts the app over as that person; no answer still ends the session. A sign-in now broadcasts `signed-in`. Tests for the visibility check, the broadcast, the announcement and the same-person no-op. | `apps/web/src/App.tsx`, `session-sync.ts`, `App.test.tsx` |
| A1-S2-3 | Fixed. Whenever the app finds no session (at launch, or any ending of it) the `ym.game.` keys are cleared; the remembered return path is kept for a signed-out visit. Test. | `apps/web/src/session-sync.ts` (`clearGameState`), `App.tsx`, `App.test.tsx` |
| A1-S2-4 | Fixed. A dependency-cruiser rule forbids `apps/web/src` and `sw` from importing `vite-plugin/` or the Vite configurations (tests excepted); the existing server-package rule also exempts `vitest.config.ts`. | `.dependency-cruiser.mjs` |
| A1-S2-5 | Fixed. A return path under a server-handled path (`SERVER_PATHS`, query and fragment ignored) is refused, in and out. The list reaches the app as a build-time constant (`define`) from `vite-plugin/defines.ts`, used by the build and the tests, so the app imports no server package. Tests for server paths and for look-alikes that are allowed. | `apps/web/vite-plugin/defines.ts`, `src/return-path.ts`, `src/globals.d.ts`, `App.test.tsx` |

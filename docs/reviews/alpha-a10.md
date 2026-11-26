# Alpha A10, its hotfix and the request-log codes: review resolutions

This record covers three changes reviewed on 2026-11-26, each by the picky review (P) and the
security review (S):

- `alpha-hotfix-1`, the words options form's controls in a dark shell (HF);
- `alpha-a10-turns`, alpha slice A10, a clearer turn on the words board (A10; spec v0.9.25);
- `alpha-logs-1`, the error code on the request log line and the sign-in address check (LOG;
  spec v0.9.26).

Each line gives the finding's ID, its outcome and where the fix lives.

## Hotfix: the word list field in a dark shell (HF)

The security review found nothing.

| ID | Outcome | Where |
|---|---|---|
| HF-P-1 | Fixed. The test checks the select rule's values, and the field's border (muted on paper) is a contrast-checked pair. | `games/words/src/client/styles.ts`, `styles.test.ts` |
| HF-P-2 | Rebutted. `color-scheme: light` on the module's root gives any future native control light defaults; the shell's other input rules target only its own email and code fields. | — |
| HF-P-3 | Fixed. The rule sits with the module's base rules. | `games/words/src/client/styles.ts` |

## A10: whose turn, and planned tiles (A10)

The security review found nothing in the slice. A10-S-1 was existing behaviour it noted.

| ID | Outcome | Where |
|---|---|---|
| A10-P-1 | Fixed. The end-to-end check picks a rack tile that isn't the blank. | `tests/e2e/src/game.spec.ts` |
| A10-P-2 | Fixed. The shell's stand-in turn line says "Sam's turn" for one seat, like the board. | `apps/web/src/screens/Frame.tsx`, `Game.test.tsx`, 07 §2 |
| A10-P-3 | Spec reworded. A turn change may give two short announcements (the chip, then the status line's hint). | 07 §2 |
| A10-P-4, A10-S-1 | Fixed. A new game version or the turn passing closes any open dialog, and nothing is sent off turn. Tests for both. | `games/words/src/client/Board.tsx`, `Board.test.tsx` |
| A10-P-5 | Fixed. The drag ghost is drawn as planned off turn. | `games/words/src/client/Board.tsx`, `Board.test.tsx` |
| A10-P-6 | Rebutted. The dashed edge is the identifying cue and is contrast-checked; the paler fill only reinforces it. | — |

## The request log says why a request failed (LOG)

| ID | Outcome | Where |
|---|---|---|
| LOG-P-1, LOG-S-1 | Fixed. One helper builds every error body and notes its code; the session gate uses it. Tests for each session-gate refusal. | `packages/server/src/http/error-log.ts`, `auth/require-session.ts`, `auth/routes.ts`, `app.ts`, `app.test.ts` |
| LOG-P-2, LOG-S-4 | Accepted as specified. Issue paths keep identifier-shaped segments; no request schema takes client-chosen keys, and the code says a future one must mask them. Test: an unknown key is never logged. | `packages/server/src/http/error-log.ts`, 09 §5 |
| LOG-P-3 | Fixed. 09 §5 lists `code`, `reason` and `issues`. | 09 §5 |
| LOG-P-4 | Fixed. The Node static 404s and the Worker's start-up 500 say why they are outside the API error contract. | `apps/node/src/server.ts`, `apps/worker/src/index.ts` |
| LOG-P-5 | Fixed. The duplicate refusal line is gone; the line kept for unexpected exceptions says why. | `packages/server/src/app.ts` |
| LOG-P-6, LOG-P-10 | Fixed. Typing and comments. | `packages/server/src/http/error-log.ts`, `platform.ts`, `app.ts` |
| LOG-P-7 | Fixed. The validation hook notes its code and issues once. | `packages/server/src/app.ts` |
| LOG-P-8 | Accepted. A domain written with a non-ASCII full stop is refused by the client's check, which says so. | `apps/web/src/text.ts` |
| LOG-P-9 | Fixed. The client check cites the address rules in 04. | `apps/web/src/text.ts` |
| LOG-S-2 | Open, existed before: a module's error codes aren't bounded at run time (the test kit checks them before install). To be filed as an issue. | — |
| LOG-S-3 | Fixed. A missing email on the session's own account logs `no_email`, not `invalid_email`. | `packages/server/src/auth/routes.ts`, `app.test.ts` |

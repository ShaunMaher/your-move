# Alpha A16 review: resolutions

This record covers the review of alpha slice A16, local score previews on the words board
(`alpha-a16-local-preview`): one round of the picky review (A16-P) and of the security review
(A16-S), which passed it. The owner checked the fixes.

| ID | Outcome | Where |
|---|---|---|
| A16-P-1 | Fixed. The end-to-end check waits until the board holds the word list, fails on any preview request, and checks the "Checking the words…" text never shows. | `tests/e2e/src/no-play.spec.ts` |
| A16-P-2 | Fixed. A test that the browser's word list agrees with the server's lookup, and that a preview over it equals the server's. | `games/words/src/engine/preview-local.test.ts` |
| A16-P-3 | Fixed. The equivalence test compares strictly. | `games/words/src/engine/preview-local.test.ts` |
| A16-P-4 | Fixed. Rebased on the current stack. | — |
| A16-P-5 | Fixed. Comment width; 07 §3 says the server remains authoritative. | `games/words/src/client/Board.tsx`, `tests/e2e/src/no-play.spec.ts`, 07 §3 |
| A16-S-1 | Fixed. The word-list module's comment describes the local preview. | `apps/web/src/word-lists.ts` |

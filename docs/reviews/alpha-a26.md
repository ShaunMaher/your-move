# Alpha A26 review (the `pairs` client and installing pairs): resolutions

This record covers the review of `alpha-a26-pairs-client`: the `pairs` board, pairs installed as the instance's fourth game type, the shell's back-forward cache handling for every game, and `test:games` resized to eight shards from the first CI measurement (spec v0.9.51). It had one round of the picky review (A26-P) and of the security review (A26-S, no medium or higher). The owner read the cache-handling fix and signed off.

| ID | Outcome | Where |
|---|---|---|
| A26-S-1 | Fixed. On `pagehide` with `persisted` the shell drops the game or list view, and on `pageshow` with `persisted` it refetches, both inside `flushSync`, so a frozen view is never painted again; tested without `act()`. | `apps/web/src/use-refresh.ts`, `screens/Game.tsx`, `screens/GameList.tsx`, 07 §4 |
| A26-S-2, A26-P-4 | Fixed. A move's answer or a "Show more" page started before a restore doesn't land after it. | `Game.tsx`, `GameList.tsx` |
| A26-S-3 | Accepted, recorded under F-27 with the mobile swipe-back preview. | `docs/security/findings.md` |
| A26-S-4 | Documented: raise `LIMIT_JOIN_LINK_IP_HOUR` for schools or carrier networks, and a wrong `TRUST_PROXY` makes it instance-wide. The e2e's higher limits are test-only. | `docs/deploy.md` |
| A26-P-1 | Fixed. The shard sizing states the measured model (runner ≈ 303 s + 4.3 × local), the corrected four-shard estimate, why eight, and that eight concurrent shards depend on the runner's `concurrent` setting. | `.gitlab-ci.yml`, `docs/deploy.md`, 10, 11 §9 |
| A26-P-2, A26-P-8 | Fixed. The matched badge's contrast is tested; names give the player number. | `games/pairs/src/client/styles.ts`, `text.ts`, pairs §9 |
| A26-P-3 | Fixed: the art test says shape and the absence of a bite were reviewed by eye (the owner checked the screenshots). | `games/pairs/src/client/art.test.tsx` |
| A26-P-5, A26-P-7 | Fixed. The e2e's mid-turn resignation happens at a fixed point, or fails naming the missing condition; the list test waits a tick. | `tests/e2e/src/pairs.spec.ts`, `GameList.test.tsx` |
| A26-P-6 | Fixed. The e2e budgets point to ADR 0004. | `tests/e2e/src/budgets.ts` |

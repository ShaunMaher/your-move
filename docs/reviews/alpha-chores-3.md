# Alpha chores 3 review: resolutions

This record covers the review of `alpha-chores-3`: two web tests that failed under load, and the
tunnel routing check on a rootless Docker engine. It had one round of the picky review (CH3-P) and
of the security review (CH3-S); the owner checked the fixes and ran the routing check on a live
rootless stack (all three checks pass).

| ID | Outcome | Where |
|---|---|---|
| CH3-P-1 | Fixed. One form of the effect flush in the test and in 11 §4. | `apps/web/src/screens/Settings.test.tsx`, 11 §4 |
| CH3-P-2, CH3-P-4 | Fixed by removing the skip. | `apps/node/scripts/check-tunnel-routing.sh` |
| CH3-P-3 | Fixed. Tests that a rootless check which isn't refused fails, and that the namespace is entered as documented. | `apps/node/src/tunnel-routing-script.test.ts` |
| CH3-S-1 | Fixed. A rootless engine is recognised only by its exact security option. | `apps/node/scripts/check-tunnel-routing.sh`, tests |
| CH3-S-2 | Fixed. The check never skips: on a rootless engine it is sent from rootlesskit's network namespace, and fails if that can't be entered. | `apps/node/scripts/check-tunnel-routing.sh`, `docs/deploy.md`, tests |

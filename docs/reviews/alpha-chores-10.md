# Alpha chores 10 review: resolutions

This record covers the review of `alpha-chores-10`, a fix for the e2e flake "a game can be resigned straight after it starts" (webkit-iphone), which failed twice on the shared runner. The cause found was a spurious "New version available" toast on the very first service-worker install: WebKit under load can show the page its first worker as controller before that worker leaves `installed`. The toast's room scrolled the page. The CSP violation reported alongside it came from Playwright's own failure screenshot.

The update is now offered only when a different worker controls the page, and the failure-screenshot noise is dropped only for tests that have already failed. The flake didn't reproduce locally, so the fix is confirmed only by later CI runs. It had one round of the picky review (CH10-P) and of the security review (CH10-S); the owner read the CSP-fixture change and signed off.

| ID | Outcome | Where |
|---|---|---|
| CH10-P-1, CH10-S-1 | Fixed in the comment: the waiting-branch guard is kept for symmetry and can't be false. | `apps/web/src/sw-register.ts` |
| CH10-P-2 | Fixed. A `controllerchange` that leaves the controller unchanged no longer reloads; tested. | `sw-register.ts`, `sw-register.test.ts` |
| CH10-P-3 | Fixed in the comment: the comparison relies on one `ServiceWorker` object per worker per client, and fails toward an extra offer. | `sw-register.ts` |
| CH10-S-2 | Backlog (M4): a minimum worker version that forces a worker-side security fix. | — |
| CH10-S-3 | Fixed. Inline `style-src` violations are dropped only from a test that has already failed; a passing test never has one excused. | `tests/e2e/src/fixtures.ts` |

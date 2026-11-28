# Alpha chores 12 review: resolutions

This record covers the review of `alpha-chores-12`: making the full kit affordable in CI before the pairs game is installed (spec v0.9.50). The game counts of 02 §6 are unchanged. The slice adds:
- one schema check per distinct view and summary;
- seeds per combination, with sharded `games:verify`;
- per-combination non-vacuity in full mode;
- a `test:games` CI job in four shards.

It had one round of the picky review (CH12-P) and of the security review (CH12-S, no high or medium). The owner read the served-JSON check and the verified-files rule and signed off.

| ID | Outcome | Where |
|---|---|---|
| CH12-S-2, CH12-P-2 | Fixed (owner decision). Views and summaries are checked as the JSON the server sends, so the deduplication is exact. | `packages/testkit/src/kit.ts` |
| CH12-P-1 | Fixed. A second traced run on the thin grids widens the pairs late-game sample. | `games/pairs/src/kit.test.ts` |
| CH12-P-5 | Fixed. T25 names `test:games`; T27 states what the isolation check plays. | 08 T25, T27 |
| CH12-P-3, CH12-P-4 | Fixed. A restricted or failing run removes `generated/verified-files.json`, so the input check fails closed; tested, as is `--only` with a duplicate type id. | `scripts/src/games/verify.ts`, 02 §7.3 |
| CH12-S-4 | Fixed. Each run reports the total combinations and a digest of the list, so shard logs can be compared. | `kit.ts`, `types.ts`, `games:verify` |
| CH12-P-6 to CH12-P-11, CH12-P-13 | Fixed. Provisional shard timeout wording; figures with and without pairs; limits and wording; a seed ceiling refused; a full-mode flag test. | 11 §9, `docs/deploy.md`, changeset, 02 §6, `kit.ts`, `kit.test.ts` |
| CH12-S-1, CH12-S-3, CH12-P-12 | Backlog (owner): the flag's cross-viewer perturbed-view assertion, cross-combination isolation games, and a shared runner-report anchor. | 10 §Pairs game |

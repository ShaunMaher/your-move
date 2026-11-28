# Alpha chores 7 review: resolutions

This record covers the review of `alpha-chores-7`: two test-job failures in the alpha MR's first
full pipeline that the local gates can't see. The routing script's stubs ran from a noexec tmpfs,
and the gmail redirect test ran under workerd on the amd64 runner (spec v0.9.40). It had one round
of the picky review (CH7-P) and of the security review (CH7-S, no findings); the owner applied the
fixes and signed off.

| ID | Outcome | Where |
|---|---|---|
| CH7-P-1 | Fixed. deploy.md and 11 §9 name all three workerd tests and the `--exclude`s. | `docs/deploy.md`, 11 §9 |
| CH7-P-2 | No change; the empty cache directory is git-ignored and harmless. | — |
| CH7-P-3 | Fixed. Reflowed the test job's comment. | `.gitlab-ci.yml` |

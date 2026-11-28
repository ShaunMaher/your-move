# Alpha chores 6 review: resolutions

This record covers the review of `alpha-chores-6`: the commitlint and gitleaks configuration that
lets the alpha's history, already on shared branches, pass the alpha MR's first full pipeline
without rewriting it (spec v0.9.39). It had one round of the picky review (CH6-P) and of the
security review (CH6-S); the owner checked the fixes and ran commitlint and gitleaks over the MR's
whole range.

| ID | Outcome | Where |
|---|---|---|
| CH6-S-1 | Fixed. The allow-list entry is anchored, so only the exact test value passes; a probe with the marker inside a longer key is reported. | `.gitleaks.toml` |
| CH6-P-1 | Fixed. 11 §7 says a subject may start with an ID, so sentence case is allowed. | 11 §7 |
| CH6-P-2, CH6-S-2 | Fixed in the comment: an exempt header skips every rule, not just the length limit. No other change; those exact headers pass every other rule. | `commitlint.config.js` |
| CH6-S-3 | No change; the relaxation is permanent by design and recorded in 11 §7. | — |

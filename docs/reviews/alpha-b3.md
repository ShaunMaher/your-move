# Alpha B3 review (usage report for the Workers cost model): resolutions

This record covers the review of `alpha-b3-usage-report`: `pnpm ops:usage`, the first measurement
of the Workers cost model (10, spec v0.9.37). One reviewer covered quality (B3-P) and privacy
(B3-S) over two rounds; the owner ran it against the live instance's request log and signed off.

| ID | Outcome | Where |
|---|---|---|
| B3-P-1 | Fixed. Health checks, HEAD and OPTIONS are counted apart and left out of the Worker figures. | `scripts/src/usage/report.ts` |
| B3-P-2 | Fixed. The report streams the log; memory grows with distinct routes, not lines. | `scripts/src/usage/report.ts` |
| B3-P-3, B3-P-6 | Fixed. The assumptions state per-player activity, gaps in the log, and that static assets are assumed free of charge, to verify against Cloudflare's billing docs. | `scripts/src/usage/report.ts` |
| B3-P-4 | Fixed. Argument handling is tested, with stdin, files, CRLF and the docker prefixes. | `scripts/src/usage/cli.ts` |
| B3-P-5, B3-P2-2 | Fixed. Line handling order; a comment on the second output filter. | `scripts/src/usage/report.ts` |
| B3-S-1, B3-S2-1 | Fixed. Only route patterns are accepted (each segment a short word, a `:param` or `*`; no query strings, ids or long hex), methods come from an allowlist, and output is stripped of control characters; anything else is counted as `(other)`. Every route in the OpenAPI document passes. | `scripts/src/usage/report.ts`, tests |
| B3-S-2 | No change; the docs use placeholders only. | `docs/deploy.md` |
| B3-P2-1 | Fixed. The large-input test is a named throughput smoke test with a generous budget. | `scripts/src/usage/report.test.ts` |

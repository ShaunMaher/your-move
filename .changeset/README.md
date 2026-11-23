# Changesets

Every merge request that changes the source of a **published** `@your-move/*` package (02 §7.4)
adds a changeset: run `pnpm changeset`, pick the packages and the semver bump, and describe the
change for the package's `CHANGELOG.md`. Other merge requests need none; Renovate's are exempt.
CI checks this with `changeset status` (11 §7).

Releases are done by hand, without a bot: a maintainer runs `pnpm changeset version` on a
`release/<yyyy-mm-dd>` branch and opens a normal merge request titled
`chore(release): version packages`. When it merges, the publish job on `main` runs
`changeset publish` to the GitLab package registry (08 §6).

Packages stay `"private": true` until the milestone that fills them (10 M0). `@your-move/sdk` and
`@your-move/testkit` left it in M1; the SDK stays `0.x` until the MVP (02 §7.4).

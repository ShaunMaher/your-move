# Licences

The project is licensed under the [BSD 2-Clause licence](../LICENSE). Everything that ships with
it must be compatible.

## The allow-list

Every **production** dependency (anything in a package's `dependencies`, which ends up in the web
app, the Worker or the Docker image) must be under one of these licences
([docs/spec/11-engineering.md §6](spec/11-engineering.md)):

- permissive licences: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0;
- public-domain dedications: CC0-1.0, Unlicense.

An SPDX expression passes when it can be satisfied from the list (`MIT OR GPL-3.0-only` passes,
`MIT AND GPL-3.0-only` doesn't). `pnpm lint:licences` checks this in CI against
`pnpm licenses list --prod`; the list lives in `scripts/src/licences/policy.ts`. Installed game
packages are held to the same list by `pnpm games:verify`, or the instance accepts a licence
explicitly with `acceptLicence` in `instance.config.ts` (02 §7.3).

Development-only tools (linters, test runners, build tools) aren't distributed and aren't checked
here. Some are under other OSI licences, e.g. `axe-core` and `@axe-core/playwright` (MPL-2.0),
used only to test accessibility.

## Accepted exceptions

Anything outside the allow-list needs an owner decision, recorded here with the package, the
exact licence string `pnpm licenses list` reports, and the decision. The licence check reads this
table.

| Package | Licence | Decision |
| ------- | ------- | -------- |

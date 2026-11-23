# 3. A mise-pinned toolchain and tool-enforced quality gates

Status: accepted (2026-11-23)

## Context

The project is built mostly by coding agents and reviewed by people and agents. Reviews are a poor
place to catch formatting, typing, boundary, licence or secret mistakes; tools catch them more
cheaply and every time. Developers and CI also need exactly the same tool versions, or "works on my
machine" and flaky CI follow.

## Decision

- **mise pins the toolchain** in `mise.toml`: Node 26.13.1, pnpm 12.21.0, and the non-npm tools
  (gitleaks, osv-scanner, oasdiff, syft). `mise.lock` records each tool's download URL and SHA-256
  for the CI platforms, and CI installs with `mise install --locked`; the mise release itself is
  checked against a SHA-256 committed in `scripts/ci/install-mise.sh`. Nothing is piped into a
  shell. `package.json` repeats the Node and pnpm pins (`packageManager` with the pnpm tarball's
  SHA-512, for corepack users). Every npm
  dependency is pinned exactly, once, in the pnpm catalog (`pnpm-workspace.yaml`); new versions
  must be three days old (`minimumReleaseAge`), install scripts are allowed only for the packages
  listed under `allowBuilds`, and peer dependencies are strict.
- **The gates** (11): Prettier; ESLint with typescript-eslint `strictTypeChecked` and
  `stylisticTypeChecked`, React, hooks, jsx-a11y (strict), import-x and eslint-comments, plus
  project rules (no hard-coded product name, no `dangerouslySetInnerHTML`, the engine globals
  allow-list); strict TypeScript with project references; dependency-cruiser architecture rules;
  knip; Vitest with coverage thresholds and fast-check; Playwright with axe-core; a licence
  allow-list over `pnpm licenses list`; gitleaks with a rule for `ym_pat_` tokens; OSV-Scanner;
  commitlint; Changesets; Renovate.
- **Every gate is shown to fail** on a deliberate violation by `pnpm gates:prove`, which CI runs
  against the real configuration.

## Consequences and the choices inside them

- **TypeScript 6.0, not 7.** TypeScript 7 (the native compiler) is current, but typescript-eslint,
  knip, dependency-cruiser and API Extractor need the TypeScript JavaScript API, which 7.0 doesn't
  offer; typescript-eslint supports `<6.1`. We use 6.0.3 for everything and revisit when the
  tooling supports 7.
- **ESLint 9, not 10.** `eslint-plugin-react` and `eslint-plugin-jsx-a11y` don't declare ESLint 10
  support yet, and peer dependencies are strict. ESLint 9 is marked deprecated on npm; we move as
  soon as both plugins support 10.
- **pnpm 12 uses `allowBuilds`** where the spec says `onlyBuiltDependencies` (the setting was
  renamed). Node 26 ships without corepack, so CI and the Dockerfile install pnpm with mise, at
  the version and SHA-256 in `mise.lock` (the same pin as `packageManager`).
- **openapi-typescript** declares a TypeScript 5 peer range; it works with 6.0's unchanged API, so
  `peerDependencyRules.allowedVersions` admits 6 for that package only.
- **Kaniko for image builds.** Rootless BuildKit needs unprivileged user namespaces, which an
  unprivileged CI container on our shared runners doesn't get (verified: `rootlesskit` fails with
  "operation not permitted"; buildah fails the same way); kaniko builds with no daemon, privileges
  or user namespaces. Upstream kaniko is archived, so we use the maintained community fork
  (osscontainertools/kaniko, Apache-2.0) from its organisation's registry
  (`ghcr.io/osscontainertools/kaniko`), pinned by digest. It publishes unsigned build provenance
  and no signatures; Renovate labels its updates for a review against the fork's release notes.
  The residual risk is accepted as F-10. The spec allows "kaniko (or rootless BuildKit)", so a
  runner that grants user namespaces can switch back without a new decision.
- **Coverage thresholds are per package**, generated from the workspace list in one Vitest run:
  each package's own sources must reach 80 % lines on their own (not as part of a repository-wide
  average), and game engines, the SDK and the testkit 95 % lines and branches. Lowering one needs
  a new ADR.
- **Prettier skips the specification and review records**, whose wide hand-written tables would
  otherwise be re-padded on every edit and bury real changes in diffs.
- Hooks (lefthook) are a convenience; CI is the gate.

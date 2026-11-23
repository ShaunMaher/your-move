# 3. A mise-pinned toolchain and tool-enforced quality gates

Status: accepted (2026-11-23)

## Context

The project is built mostly by coding agents and reviewed by people and agents. Reviews are a poor
place to catch formatting, typing, boundary, licence or secret mistakes; tools catch them more
cheaply and every time. Developers and CI also need exactly the same tool versions, or "works on my
machine" and flaky CI follow.

## Decision

- **mise pins the toolchain** in `mise.toml`: Node 26.13.1, pnpm 12.21.0, and the non-npm gate
  tools (gitleaks, osv-scanner, oasdiff). `package.json` repeats the Node and pnpm pins. Every npm
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
  renamed). Node 26 ships without corepack, so CI and the Dockerfile install the pnpm version named
  in `packageManager` with npm.
- **openapi-typescript** declares a TypeScript 5 peer range; it works with 6.0's unchanged API, so
  `peerDependencyRules.allowedVersions` admits 6 for that package only.
- **Kaniko for image builds.** Rootless BuildKit needs unprivileged user namespaces, which an
  unprivileged CI container on our shared runners doesn't get (verified: `rootlesskit` fails with
  "operation not permitted"); kaniko builds with no daemon, privileges or user namespaces. We use
  the maintained community fork (osscontainertools/kaniko, Apache-2.0), pinned by digest.
- **Coverage thresholds** are glob-based in one Vitest run, so per-area thresholds hold without a
  separate run per package. Lowering one needs a new ADR.
- **Prettier skips the specification and review records**, whose wide hand-written tables would
  otherwise be re-padded on every edit and bury real changes in diffs.
- Hooks (lefthook) are a convenience; CI is the gate.

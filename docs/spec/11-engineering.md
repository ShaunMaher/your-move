# 11 — Engineering standards

The bar for this repository: a codebase any developer would be glad to work in, where the tools,
not reviewers' memories, catch most mistakes. Everything here is delivered in M0 (10) and enforced
in CI from the first commit. Changing a standard needs an ADR (§10).

## 1. Toolchain

- **mise** pins the toolchain in `mise.toml` at the repository root: **Node 26 LTS** and
  **pnpm 12**, exact versions (e.g. `node = "26.13.1"`, `pnpm = "12.21.0"`). Renovate keeps them
  current (§8). If a dependency we need doesn't support the pinned Node major yet, fall back to the
  previous LTS and record why in an ADR.
- `package.json` repeats the pins for people without mise: `"packageManager": "pnpm@<version>"`
  (corepack) and `"engines": { "node": ">=26 <27" }`; `engine-strict=true` in `.npmrc`.
- CI uses the same pins (§9): job images are built from the pinned Node version, and pnpm comes
  from `packageManager`.
- No global installs are assumed beyond mise (or Node + corepack) and Docker (for the Docker image
  and some e2e setups). `pnpm install` then provides every other tool.

## 2. TypeScript

- `strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `isolatedModules`,
  `useUnknownInCatchVariables`.
- ES2023 target, `module`/`moduleResolution` `NodeNext` for libraries (`Bundler` for the web app),
  ESM only.
- **Project references**: one `tsconfig.json` per package extending `tsconfig.base.json`; a root
  solution file; `pnpm typecheck` runs `tsc -b`. Published packages emit declarations.
- `any` is banned (lint); `unknown` plus a Zod parse at every trust boundary (HTTP, storage,
  config, module output in tests).

## 3. Code style, lint and generated code

- **Prettier** formats everything it understands (TS, JSON, YAML, Markdown, CSS). `pnpm format`
  writes; CI runs `prettier --check`. No style debates in review.
- **ESLint** (flat config, `eslint.config.js`):
  - `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked` with type information;
  - `eslint-plugin-react`, `react-hooks`, `jsx-a11y` (strict) for the web app and game clients;
  - `eslint-plugin-import-x` (or `simple-import-sort`) for ordering, no cycles, no extraneous deps;
  - `@eslint-community/eslint-comments` with `require-description`: every disable comment states
    why, and `no-unused-disable` removes stale ones;
  - `no-console` outside `apps/*` entry points and scripts (use the logger, 09 §5);
  - project rules from CLAUDE.md where lint can check them: no `Math.random`, `Date.now`, `crypto`
    or timers in `games/*/engine` and the SDK's pure parts; no `dangerouslySetInnerHTML`;
    no hard-coded `"Your Move"` string outside config defaults.
- Warnings fail CI (`--max-warnings 0`).
- **Generated code** is never edited by hand and lives in clearly marked places: the OpenAPI
  document and `@your-move/api-client` (generated from `@your-move/shared`'s schemas, 05 §Versioning),
  the game registry and client import map (`pnpm games:generate`, 02 §7.3), Drizzle migrations
  (reviewed, then committed). CI regenerates and fails if the committed output differs.

## 4. Tests

| Layer | Tool | Scope | Gate |
|---|---|---|---|
| Unit and integration | Vitest | every package; repositories against both drivers (03 §4) | runs on every MR |
| Property-based | fast-check (inside Vitest) | engines, rule invariants, tile conservation, parsers | seeded; a failure prints the seed |
| Game contract | `@your-move/testkit` (02 §6) | every installed game package | runs on every MR and in `pnpm games:verify` |
| API contract | Vitest + `@your-move/api-client` | the same suite against the Node build and the Worker build (Miniflare / `@cloudflare/vitest-pool-workers`) | runs on every MR |
| Component | Vitest + Testing Library | web app and game clients | runs on every MR |
| End-to-end | Playwright | WebKit (iPhone viewport) and Chromium; real server + SQLite | runs on every MR (sharded) |
| Accessibility | axe-core in Playwright | every screen | zero serious/critical violations |

- **Coverage** (V8, reported to GitLab as Cobertura): `games/*/engine` and `packages/sdk` +
  `packages/testkit` ≥ 95 % lines and branches; every other package ≥ 80 % lines. Thresholds fail
  the job; lowering one needs an ADR.
- Tests are deterministic: injected clock (`Platform.now`), seeded `RandomSource`, no network
  (outbound calls are faked at the `Platform` boundary), no sleeps. A flaky test is a bug and is
  quarantined with an issue, never retried silently.
- Every bug fix lands with a test that failed before the fix.

## 5. Architecture rules

`dependency-cruiser` enforces the boundaries in CLAUDE.md and 02 §7.5 (`pnpm lint:arch`):

- `games/*/engine` → only `@your-move/sdk` and its own files. No `node:*`, no runtime packages, no
  framework packages, no DOM, no React.
- `games/*/client` → only `@your-move/sdk`, React and its own engine.
- `packages/server` → no `apps/*`, no game packages (only the generated registry), no
  Cloudflare- or Node-specific modules (03 principle 1).
- `packages/sdk` → no runtime dependencies at all.
- `apps/web` → the API only through `@your-move/api-client`; no `packages/server` imports.
- No circular dependencies anywhere; no orphaned modules.

The game-facing part of these rules ships in `@your-move/testkit` so third-party game repos and
`pnpm games:verify` use exactly the same ruleset (02 §7.5).

## 6. Dependency and repository hygiene

- **knip**: no unused files, exports, dependencies or devDependencies (`pnpm lint:unused`).
- **Licences**: every production dependency's licence must be on the allow-list — MIT, ISC,
  BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0, CC0-1.0, Unlicense. Anything else needs an owner decision recorded in `docs/licences.md`. The same
  allow-list applies to installed game packages (02 §7.3).
- **Secrets**: gitleaks in pre-commit and CI, with a custom rule for `ym_pat_` tokens (06 §8);
  `.env*` files ignored (an `.env.example` is committed).
- **Vulnerabilities**: OSV-Scanner on the lockfile in CI and on a nightly schedule; a known
  vulnerability in a production dependency fails the pipeline unless an accepted-risk entry with an
  expiry date exists in `docs/security/findings.md`.
- **pnpm**: `--frozen-lockfile` everywhere; `onlyBuiltDependencies` lists the few packages allowed
  to run install scripts (08 §6); `minimumReleaseAge` for new versions; `strict-peer-dependencies`.
- Repository files: `.editorconfig`, `.gitattributes` (LF line endings, lockfile marked generated),
  `CODEOWNERS` (owner reviews `docs/spec/`, `.gitlab-ci.yml`, `08`-relevant code), `SECURITY.md`,
  `CONTRIBUTING.md` (dev setup, commit convention, changesets, the review process).

## 7. Git workflow and releases

- `main` is protected: changes land only through merge requests with a green pipeline and the
  review process in CLAUDE.md. Branches are named `m<N>-<slug>`, `spec-<version>`, `fix/<slug>` or
  `renovate/*`.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `build:`,
  `ci:`; `!` for breaking), enforced by commitlint on every commit in an MR and on the MR title
  (squash commits use the title).
- **lefthook** pre-commit hooks (installed by `pnpm install`): Prettier and ESLint on staged files,
  gitleaks on the staged diff. Pre-push: `pnpm typecheck`. Hooks are a convenience; CI is the gate.
- **Changesets** version and release the published `@your-move/*` packages (02 §7.4): every MR
  that changes a published package includes a changeset; `main` opens a "Version packages" MR, and
  merging it publishes from CI (08 §6) and writes `CHANGELOG.md` per package. The app itself is
  versioned from the same flow (`@your-move/server` version = instance version).

## 8. Dependency updates (Renovate)

Renovate runs as a scheduled pipeline on this GitLab project with the `RENOVATE_TOKEN` project
access token (masked, protected CI variable; rotation noted in the operator's private notes).
`renovate.json`:

- extends `config:best-practices` (pins Docker images and CI images by digest, `:pinDevDependencies`,
  config migration);
- schedule: weekly (weekend), plus security updates at any time;
- `minimumReleaseAge` 3 days for npm packages;
- groups: monorepo packages together (typescript-eslint, Vitest, Playwright, Hono, Drizzle,
  React), all `@types/*` together, CI images together;
- **automerge** only for patch/minor **devDependencies** and lockfile maintenance, after a green
  pipeline; runtime dependencies, game packages (`@*/game-*`), the SDK's dependencies and major
  updates are never automerged;
- lockfile maintenance monthly;
- covers `mise.toml` (Node, pnpm), Dockerfiles, `.gitlab-ci.yml` images and `package.json`;
- the Dependency Dashboard issue is enabled and is the single place to see pending updates.

## 9. CI pipeline (`.gitlab-ci.yml`)

Pipelines run for merge requests and for `main`/tags (no duplicate branch pipelines). The pnpm
store is cached by lockfile hash. Stages:

1. **validate** — `prettier --check`, ESLint, `tsc -b`, `pnpm lint:arch`, knip, commitlint (MR),
   generated-code drift (§3), OpenAPI breaking-change check against the target branch (oasdiff,
   05 §Versioning), `pnpm games:verify` (02 §7.3).
2. **test** — Vitest with coverage (unit, integration, property, component, game contract, API
   contract on both runtimes); JUnit and Cobertura reports to the MR.
3. **e2e** — Playwright (WebKit + Chromium), traces and screenshots kept as artifacts on failure.
4. **security** — gitleaks, OSV-Scanner, licence check (§6).
5. **build** — web app, Worker bundle, multi-arch Docker image (`linux/amd64` on the x86 runner,
   `linux/arm64` on the arm64 runner, then a manifest), CycloneDX SBOM.
6. **publish** (`main`/tags only) — Changesets publish to the GitLab package registry; Docker image
   to the GitLab container registry (09 §6).
7. **deploy** (manual, `production` environment, 09 §6).

A scheduled pipeline runs Renovate (§8) and the nightly OSV scan. Every job has a timeout;
pipeline wall time on an MR should stay under 15 minutes (track it; split or shard when it grows).

## 10. Architecture decision records

Significant decisions are recorded as short ADRs in `docs/adr/NNNN-title.md` (context, decision,
consequences; status `accepted` / `superseded by NNNN`). The spec says *what*; ADRs say *why we
chose it over the alternatives*. M0 writes the first three:

1. API first, with Durable Objects only as a realtime channel (03 §1, §5.1);
2. Games as packages composed at build time (02 §7);
3. mise-pinned toolchain and the quality gates in this document.

## 11. Documentation

- `README.md`: what it is, quick start (mise → `pnpm install` → `pnpm dev:node`), links.
- `CONTRIBUTING.md`: development setup, commands, commit convention, changesets, review process.
- `docs/guides/writing-a-game.md` — the guide for third-party game authors, built around
  `@your-move/game-example` (02 §7.6). Outline (the M1 stub lists these sections; the full guide is
  an M1 deliverable, revised in M5):
  1. What a game package is (engine, client, manifest) and the trust model (02 §7.5)
  2. Setting up a game repo (template, `.npmrc` for the registry, the SDK and testkit)
  3. Writing the engine: options, setup, `toAct`, validate/apply, views and secrecy, randomness
  4. Running the test kit and the architecture rules
  5. Writing the client: Board, OptionsForm, RulesSheet, HistoryItem; previews
  6. Versioning rules and state (rules versions, package semver, SDK compatibility)
  7. Publishing and installing into an instance (`instance.config.ts`, `pnpm games:verify`)
  8. Checklist before you publish
- Public API reference: the generated OpenAPI document and its docs page (05).

## 12. Definition of done

A change is done when: the spec is updated (or the change matches it), tests cover it at the
thresholds, the pipeline is green with no new warnings, changesets are added for published
packages, docs and ADRs are updated where the behaviour or a decision changed, and the review
process in CLAUDE.md has signed it off.

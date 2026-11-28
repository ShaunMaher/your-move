# 11 — Engineering standards

The bar for this repository: a codebase any developer would be glad to work in, where the tools,
not reviewers' memories, catch most mistakes. Everything here is delivered in M0 (10) and enforced
in CI from the first commit. Changing a standard needs an ADR (§10).

## 1. Toolchain

- **mise** pins the toolchain in `mise.toml` at the repository root: **Node 26 LTS** and
  **pnpm 12**, exact versions (e.g. `node = "26.13.1"`, `pnpm = "12.21.0"`). Renovate keeps them
  current (§8). If a dependency we need doesn't support the pinned Node major yet, fall back to the
  previous LTS and record why in an ADR.
- `package.json` repeats the pins for people without mise:
  `"packageManager": "pnpm@<version>+sha512.<hash>"` (corepack verifies the hash) and
  `"engines": { "node": ">=26 <27" }`; `engine-strict=true` in `.npmrc`.
- CI uses the same pins (§9): job images are built from the pinned Node version. Node 26 ships
  without corepack, so CI and the Dockerfile install pnpm with mise at the version and SHA-256 in
  `mise.lock` (the same version as `packageManager`). The mise release itself is downloaded and
  checked against a SHA-256 committed in `scripts/ci/install-mise.sh`; nothing is piped into a
  shell. **Deliberate exception:** the e2e job runs in the Playwright image, whose Node is Node 26
  but not necessarily the exact pinned patch; Renovate keeps the image current.
- `mise.toml` also pins the **non-npm tools** the gates need, so a fresh clone gets them from
  `mise install` (mise `aqua`/`ubi`/`github` backends): **gitleaks**, **osv-scanner**, **oasdiff**
  and **syft** (SBOMs). `mise.lock` records each tool's URL and checksum for the CI platforms, and
  CI installs with `mise install --locked`. The validate job checks the pins agree: `pnpm
  lint:pins` (every Node pin — `mise.toml`, the Dockerfile, the CI images — and both pnpm pins)
  and `mise lock --check` (`mise.lock` matches `mise.toml`). CI jobs use the full Node image, which
  has git and the system CA certificates that non-Node tools verify TLS with; the server image
  stays slim.
- No global installs are assumed beyond mise (or Node + corepack plus those binaries) and
  Docker (for the Docker image and some e2e setups). `pnpm install` provides every npm tool.

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
  writes; CI runs `prettier --check`. No style debates in review. Excluded (`.prettierignore`):
  generated output (the lockfile, `generated/`, build output, API Extractor reports, changelogs),
  CI caches kept in the project directory, fixture packages, and hand-maintained records with wide
  tables — `docs/spec/`, `docs/reviews/`, `docs/security/findings.md` and `.claude/` — whose
  re-padding would bury real changes in diffs.
- **ESLint** (flat config, `eslint.config.js`):
  - `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked` with type information;
  - `eslint-plugin-react`, `react-hooks`, `jsx-a11y` (strict) for the web app and game clients;
  - `eslint-plugin-import-x` for import ordering, `no-cycle` and `no-extraneous-dependencies`;
  - `@eslint-community/eslint-comments` with `require-description`: every disable comment states
    why, and `no-unused-disable` removes stale ones;
  - `no-console` outside `apps/*` entry points and scripts (use the logger, 09 §5);
  - project rules from CLAUDE.md where lint can check them: no `Math.random`, `Date.now`, `crypto`
    or timers in `games/*/engine` and the SDK's pure parts; no `dangerouslySetInnerHTML`;
    no hard-coded `"Your Move"` string outside config defaults.
- Warnings fail CI (`--max-warnings 0`).
- **Generated code** is never edited by hand and lives in clearly marked places:
  - **committed**, and CI regenerates and fails on any difference: the OpenAPI document and
    `@your-move/api-client` (`openapi-typescript` + `openapi-fetch`, generated from the route
    schemas, 05 §Versioning), the SDK's API Extractor report (`@microsoft/api-extractor`, 02 §7.4)
    and Drizzle migrations (reviewed, then committed);
  - **not committed** (git-ignored `generated/`): the game registry, the client import map and
    `installed.json` (`pnpm games:generate`, 02 §7.3), which depend on the instance's installed
    games. Only `apps/*` import them (§5). Because tools that read `apps/*` (`tsc -b`, type-aware
    ESLint, knip, dependency-cruiser, Vitest) need them, `games:generate` runs from the root
    `prepare` script (so `pnpm install` on a fresh clone produces them) and again at the start of
    `pnpm typecheck`, `pnpm lint` and `pnpm test`; CI's validate stage runs it first (§9).

## 4. Tests

| Layer | Tool | Scope | Gate |
|---|---|---|---|
| Unit and integration | Vitest | every package; repositories against both drivers (03 §4) | runs on every MR |
| Property-based | fast-check (inside Vitest) | engines, rule invariants, tile conservation, parsers | seeded; a failure prints the seed |
| Game contract | `@your-move/testkit` (02 §6) | every installed game package | **full** kit on every MR (test stage); **fast** kit in `pnpm games:verify` during `pnpm build` and the Docker build (never in the deploy job, 08 §6) |
| API contract | Vitest + `@your-move/api-client` | the same suite against the Node build and the Worker build (Miniflare / `@cloudflare/vitest-pool-workers`) | runs on every MR |
| Component | Vitest + Testing Library | web app and game clients | runs on every MR |
| End-to-end | Playwright | WebKit (iPhone viewport) and Chromium; real server + SQLite | runs on every MR (sharded) |
| Accessibility | axe-core in Playwright | every screen | zero serious/critical violations |

- **Coverage** (V8, reported to GitLab as Cobertura): `games/*/engine` and `packages/sdk` +
  `packages/testkit` ≥ 95 % lines and branches; every other package ≥ 80 % lines. Thresholds fail
  the job; lowering one needs an ADR.
- Tests are deterministic: injected clock (`Platform.now`), seeded `RandomSource`, no network
  (outbound calls are faked at the `Platform` boundary), no sleeps. A flaky test is a bug and is
  quarantined with an issue, never retried silently. Slow test infrastructure gets deliberate time
  budgets instead, sized from measurements and documented where they are set: in e2e, a browser's
  launch and its first page each have their own budget, so neither is charged to a test's timeout.
  Statistical timing tests (06 §3.2) are measurements, the one exception to determinism: they run
  in a CI job of their own, never alongside another suite, are run locally before any change to
  the paths they time is handed off, and are re-measured rather than retried when they fail
  (ADR 0006).
- Two causes of load-dependent flakes in UI tests, found by looping a file under CPU load: React runs
  passive effects (`useEffect`) after the commit, and under load a `findBy*` can resolve, and the
  test act, before they have run. So a test never asserts an effect's result (the address bar, a
  `data-theme` attribute, focus) synchronously after a `findBy*`: it uses `waitFor`, or flushes
  with `await act(() => Promise.resolve())` before acting on state an effect may still overwrite.
- The tunnel stack test (`apps/node/src/tunnel-stack.test.ts`, which runs
  `apps/node/scripts/check-tunnel-routing.sh` against a real compose stack) needs a Docker engine
  and the app image, so it is skipped unless `TUNNEL_STACK_IMAGE` names one. Run it after any
  change to `apps/node/docker-compose.tunnel.yml`, to `TRUST_PROXY_PEERS` or to the `app-front`
  alias: `docker build -f apps/node/Dockerfile .`, then
  `TUNNEL_STACK_IMAGE=<image> pnpm exec vitest run --project apps/node src/tunnel-stack.test.ts`.
- Every bug fix lands with a test that failed before the fix.

## 5. Architecture rules

`dependency-cruiser` enforces the boundaries in CLAUDE.md and 02 §7.5 (`pnpm lint:arch`):

- `games/*/engine` and `games/*/manifest` → only `@your-move/sdk` and `@your-move/sdk/schema`
  (never `@your-move/sdk/client`) and their own files. No `node:*`, no runtime packages, no
  framework packages, no DOM, no React.
- `games/*/client` → only `@your-move/sdk` (including `@your-move/sdk/client`), React, its own
  engine and the packages it declares in `dependencies` (02 §7.1.1).
- `packages/server` → no `apps/*`, no game packages and **not** `generated/` (the game registry is
  injected by `apps/worker` and `apps/node` through `createApp({ platform, games })`, 02 §7.3), no
  Cloudflare- or Node-specific modules (03 principle 1).
- `generated/` → imported only by `apps/worker`, `apps/node` (server registry) and `apps/web`
  (client import map).
- `packages/sdk` → no dependencies; `zod` and `react` are peer dependencies only (02 §7.4); only the
  `@your-move/sdk/client` entry point may import React.
- `apps/web` → the API only through `@your-move/api-client`; no `packages/server` imports.
- No circular dependencies anywhere; no orphaned modules.

The game-facing part of these rules ships in `@your-move/testkit` so third-party game repos and
`pnpm games:verify` use exactly the same rules (02 §7.5): the dependency-cruiser ruleset
(`@your-move/testkit/depcruise`) for imports, and an ESLint config
(`@your-move/testkit/eslint-engine`) run on **built engine and manifest output** for the globals
allow-list and the no-writes-to-built-ins rule — dependency-cruiser can't see globals.

## 6. Dependency and repository hygiene

- **knip**: no unused files, exports, dependencies or devDependencies (`pnpm lint:unused`).
  Placeholder packages and exports that exist only for a later milestone are listed in knip's
  `ignore` with a comment naming the milestone, and removed from it when that milestone lands.
- **Licences**: every production dependency's licence must be on the allow-list — MIT, ISC,
  BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0 (permissive licences), and the
  public-domain dedications CC0-1.0 and Unlicense. Anything else needs an owner decision recorded
  in `docs/licences.md`. The check (`pnpm lint:licences`) is a small script over
  `pnpm licenses list --json --prod` — no extra dependency. The same allow-list applies to
  installed game packages (02 §7.3).
- **Secrets**: gitleaks in pre-commit and CI, with a custom rule for `ym_pat_` tokens (06 §8);
  `.env*` files ignored (an `.env.example` is committed).
- **Vulnerabilities**: OSV-Scanner on the lockfile in CI and on a nightly schedule; a known
  vulnerability in a production dependency fails the pipeline unless it is ignored in
  `osv-scanner.toml` with `ignoreUntil` and a `reason` that names an accepted-risk entry
  (`F-<n>`) in `docs/security/findings.md` with the same expiry.
- **pnpm**: `--frozen-lockfile` everywhere; `allowBuilds` (pnpm 12's name for the former
  `onlyBuiltDependencies`) lists the few packages allowed to run install scripts (08 §6);
  `minimumReleaseAge` for new versions; `strict-peer-dependencies`.
- Repository files: `.editorconfig`, `.gitattributes` (LF line endings, lockfile marked generated),
  `CODEOWNERS` (owner reviews `docs/spec/`, `.gitlab-ci.yml`, `08`-relevant code), `SECURITY.md`,
  `CONTRIBUTING.md` (dev setup, commit convention, changesets, the review process).

## 7. Git workflow and releases

- `main` is protected: changes land only through merge requests with a green pipeline and the
  review process in CLAUDE.md. Branches are named `m<N>-<slug>`, `spec-<version>`, `fix/<slug>`,
  `release/<yyyy-mm-dd>` or `renovate/*`.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `build:`,
  `ci:`; `!` for breaking), enforced by commitlint on every commit in an MR and on the MR title
  (squash commits use the title). A subject may start with a slice, finding or issue ID, so
  sentence case is allowed. Renovate is configured with `:semanticCommits` so its commits
  pass; release commits are `chore(release): version packages`.
- **lefthook** pre-commit hooks (installed by `pnpm install`): Prettier and ESLint on staged files,
  gitleaks on the staged diff. Pre-push: `pnpm typecheck`. Hooks are a convenience; CI is the gate.
- **Changesets** version and release the `@your-move/*` packages (02 §7.4), **without a bot**.
  `.changeset/config.json` sets `privatePackages: { version: false, tag: false }`: only published
  packages are versioned by Changesets; the instance (the unpublished app) is versioned by `v*` git
  tags on `main`. The rule, stated plainly: **every MR that changes the source of a published
  package includes a changeset**; other MRs need none. CI checks it in MR
  pipelines with `git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"` followed by
  `changeset status --since="$CI_MERGE_REQUEST_DIFF_BASE_SHA"` (a plain `origin/main` isn't
  fetched in MR pipelines). Renovate MRs are exempt. To release, a maintainer runs
  `pnpm changeset version` on a `release/<date>` branch and opens a normal MR; when it merges, the
  publish job on `main` runs `changeset publish` (08 §6: `release` environment, deploy token, never
  `CI_JOB_TOKEN`) and `CHANGELOG.md` is written per package. Packages stay `"private": true` until
  their milestone (10 M0), so nothing unfinished is published. The SDK stays `0.x` until M4.

## 8. Dependency updates (Renovate)

Renovate runs as a scheduled pipeline on this GitLab project with the `RENOVATE_TOKEN` project
access token (Developer role, no merge rights on `main`): a masked, protected CI variable **scoped
to the `renovate` environment**, which only the scheduled Renovate job uses — no lint, test or
build job can read it (08 §6). Rotation is noted in the operator's private notes.
`renovate.json`:

- extends `config:best-practices` (pins Docker images and CI images by digest, `:pinDevDependencies`,
  config migration) and `:semanticCommits`; `ignoreScripts: true`;
- schedule: weekly (weekend), plus security updates at any time;
- `minimumReleaseAge` 3 days for npm packages;
- groups: monorepo packages together (typescript-eslint, Vitest, Playwright, Hono, Drizzle,
  React), all `@types/*` together, CI images together;
- **no automerge at all**: every update — dev dependencies (test and build tools shape the
  production bundle), lockfile maintenance, runtime dependencies, game packages, majors — opens an
  MR that goes through the normal review (08 §6). Game packages are recognised from the list in
  `instance.config.ts` (a `packageRules` entry generated from it), not from a name pattern, and get
  their own label so their diffs are read with the trust model in mind (02 §7.5);
- lockfile maintenance monthly;
- covers `mise.toml` (Node, pnpm), Dockerfiles, `.gitlab-ci.yml` images and `package.json`;
- the Dependency Dashboard issue is enabled and is the single place to see pending updates.

## 9. CI pipeline (`.gitlab-ci.yml`)

Pipelines run for merge requests and for `main`/tags (no duplicate branch pipelines). The pnpm
store and mise's tools are cached inside the project directory, keyed by `pnpm-lock.yaml` and
`mise.lock` and per architecture (mise's tools and native packages differ); only one job per
architecture writes them (validate on amd64, `test:timing` on arm64), and every job checks pnpm
uses the cached store.
Jobs run unprivileged (no Docker-in-Docker); untagged jobs run on the amd64 shared runner, whose
CPU must offer x86-64-v2 (SSE4.2): workerd's linux-64 build fails to start without it (M0 review
CI-1; the runner's VM now does, so the workerd tests run in `test` with everything else). Stages,
in order:

1. **validate** — `pnpm games:generate` first (§3), then `prettier --check`, ESLint, `tsc -b`,
   `pnpm lint:arch`, knip, commitlint (MR),
   changeset check (§7), committed generated-code drift (§3), OpenAPI breaking-change check against
   the target branch (`oasdiff breaking`, 05 §Versioning), API Extractor report check.
2. **test** — Vitest with coverage (unit, integration, property, component, the **full** game
   kit, API contract on both runtimes, workerd included); JUnit and
   Cobertura reports to the MR.
3. **build** — `pnpm games:verify --fast`, web app, Node server build (`apps/node/dist`), Worker
   bundle, then `pnpm games:check-inputs` (the bundler-input closure check, 02 §7.3; the whole
   sequence is `pnpm build`), `generated/installed.json` kept as an artifact for the deploy job, Docker image per
   architecture built natively with kaniko (or rootless BuildKit, where the runner grants user
   namespaces; `linux/amd64` job tagged `arch-amd64`, `linux/arm64` job tagged `arch-arm64`).
   CycloneDX SBOMs of what each deployment ships (`pnpm sbom:app`: the production dependencies
   of the root, the web app and the Node server or the Worker) and, on `main`/tags, of each image;
   image labels naming the commit and pipeline. MR pipelines build but never
   push or keep the image, so nothing on an MR runs it.
4. **e2e** — Playwright (WebKit + Chromium) against the **Node build output** from stage 3
   (`node apps/node/dist` with SQLite), not the Docker image; traces and screenshots kept as
   artifacts on failure.
5. **security** — gitleaks, OSV-Scanner, licence check (§6).
6. **publish** (`main`/tags only, `release` environment, release credentials, 08 §6) —
   `changeset publish` to the GitLab package registry; per-arch images pushed and joined into a
   multi-arch manifest with `crane`; digests recorded in the release notes (from M1); then a **smoke job**
   pulls the new image by digest as a `services:` container and checks `/api/health` (09 §6).
7. **deploy** (manual, `production` environment, 09 §6). The stage exists from M0; the Cloudflare
   deploy job arrives with the first Workers deployment (10), built to these constraints: it
   reuses the stage-3 artifact and deploys `dist/worker` with `--no-bundle`; wrangler comes from a
   lockfile-pinned, `--ignore-scripts` install carried as an artifact (e.g. `pnpm deploy --prod`
   of a small deployer package), never fetched in the job; its configuration is generated from CI
   variables; it runs no `pnpm install`; it runs `games:check-db` from `installed.json` only, as a
   self-contained bundle built in stage 3 and carried in the same artifact, and never runs
   `games:verify` or imports game package code while holding deploy credentials (08 §6).

**Environments on GitLab CE.** Our GitLab is Community Edition, which has no protected
environments. Every secret is a variable that is both **protected** (only `main`, which only
Maintainers can push or merge to, and protected `v*` tags receive it) and **scoped to one
environment** (`release`, `renovate` or `production`), so only the jobs on protected refs that
declare that environment get it (08 §6).

Stages 1–5 run on every MR; that's what "green on an MR" means. Each gate is shown to fail by
**fixture tests in CI** (e.g. a fixture file with a lint error, an import breaking an architecture
rule, a fake `ym_pat_` secret, a disallowed licence in a fixture manifest, an engine fixture using
`Math.random`), run against the real configs, not by one-off throwaway MRs.

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
- Public API reference: the generated OpenAPI document (`/api/v1/openapi.json`, 05). There is no
  rendered docs page in v1 (CSP, 05 §Versioning); the README says how to open it in a local viewer.

## 12. Definition of done

A change is done when: the spec is updated (or the change matches it), tests cover it at the
thresholds, the pipeline is green with no new warnings, changesets are added for published
packages, docs and ADRs are updated where the behaviour or a decision changed, and the review
process in CLAUDE.md has signed it off.

# 2. Games as packages composed at build time

Status: accepted (2026-11-23)

## Context

The platform should host more than its first two games, including games written by other people in
their own repositories. Cloudflare Workers can't load code at runtime, and a game engine runs
inside the server process with access to other games' hidden state, so how games are installed is
both an architecture and a trust question (02 §7, 08 T27).

## Decision

- **A game is an npm package** with three entry points — `/engine` (`engines`, one
  `GameDefinition` per rules version), `/client` and `/manifest` — built JavaScript plus `.d.ts`,
  with `@your-move/sdk`, `zod` and `react` as peer dependencies only. First-party games under
  `games/` have exactly this shape and get no special path.
- **An instance's games are fixed at build time** by `instance.config.ts`. `pnpm games:generate`
  writes the git-ignored `generated/` directory: the server registry, the client import map and a
  plain-data `installed.json`. Only `apps/*` import them; `packages/server` receives the registry
  through `createApp({ platform, games })` and never imports a game.
- **`pnpm games:verify`** checks every installed package at build time: unique valid type ids, the
  SDK peer range, the licence allow-list (or an explicit `acceptLicence`), the dependency rules and
  the import ruleset; from M1 also the generic test kit and the built-output ESLint rules. The
  rules ship in `@your-move/testkit`, so game authors run exactly the same checks.
- **Deploy-time and startup orphan checks read only `installed.json`**, never package code, so no
  game code runs while deploy credentials are present.

## Consequences

- Installing a game is a code change and a review, like any dependency; Renovate never merges game
  updates by itself.
- The trust model is explicit: installing a game is full trust. The build-time rules make honest
  games verifiable and accidents unlikely; they don't sandbox a dishonest one (accepted risk F-5).
- The SDK is a real, semver-versioned contract with a committed API Extractor report, so an
  accidental surface change fails CI.
- Removing a game type or rules version that live games still use is caught at deploy and start
  time rather than at build time, because the build can't see the database.

## Alternatives considered

- **Games inside the framework** — simplest at first, but every new game would be a framework
  change, and third-party games would be impossible.
- **Runtime plugin loading** — impossible on Workers, and it would move the trust decision from
  the operator's build to whoever can write to the plugin location.
- **Sandboxed engines (separate Worker, `worker_threads`, WebAssembly)** — the right long-term
  hardening, kept possible by the pure, synchronous engine contract, but too much for v1.

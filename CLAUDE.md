# Project guide for Claude

**Your Move**: a platform for asynchronous turn-based multiplayer games with friends (first games: a crossword-tile
word game and a path-laying tile game): mobile-first React PWA, runtime-agnostic TypeScript server
deployable to Cloudflare Workers (D1 + Durable Objects) or Docker (Node + SQLite). BSD-2-Clause.

**The spec in `docs/spec/` is the source of truth.** Read `docs/spec/README.md` first, then the
documents relevant to your task. If the spec is wrong or ambiguous, stop and raise it — don't
silently diverge. Unanswered owner decisions are in `docs/spec/open-questions.md`; use the
recommended default and note that you did.

## Hard rules

- **Never hard-code the product name.** The project is called Your Move, but code, copy, emails and
  manifests use `APP_NAME` from config (default `Your Move`) so forks can rebrand. Package scope is `@app/*`.
- **No trademarked names** (Scrabble, Words With Friends, etc.) in code, UI, docs-for-users or assets.
  Spec docs may reference them only to describe lineage.
- Game engines (`games/*/engine`) are pure: no I/O, no `Date.now()`, no `Math.random()`, no direct
  `crypto` calls, no imports from the framework or runtimes. Randomness arrives as a `RandomSource`
  argument (02 §2). Every module must pass the generic test kit (02 §6).
- The framework (`packages/server`) knows games only through the `GameDefinition` contract — no
  game-specific code in the framework. Game UIs talk to the API only through the shell's
  `submit`/`preview` (02 §3).
- **No trademarked game names, characters, art or look** for any game module — shared mechanics
  only, with our own names and original art.
- Core server code (`packages/server`) uses Web-standard APIs only. Cloudflare-specific code lives in
  `apps/worker`, Node-specific code in `apps/node`.
- Game data reaches clients only through module `view()`, the viewer's own `final_views` entry,
  public `record`s and their `describe` text. Never serialise `games.state`, recorded `rng`, or raw `game_actions.action`.
- Core code never touches a Drizzle database object directly — go through repository interfaces
  (03 §4). Every game state change goes through the `write_token` transition (03 §5.2).
- Production randomness: WebCrypto only.
- No `dangerouslySetInnerHTML`, no inline scripts, no third-party runtime resources in the client.
- New runtime dependencies need a one-line justification in the PR/commit message and must be
  permissively licensed.
- Every file you add is BSD-2-Clause compatible; don't copy code from incompatible sources.

## Agent workflow (per milestone in docs/spec/10-roadmap.md)

1. **coder** implements the milestone on a feature branch, with tests, until CI-equivalent checks
   pass locally (`pnpm lint && pnpm typecheck && pnpm test`).
2. **picky-reviewer** reviews the diff against the spec and code-quality bar; returns findings.
3. **security-reviewer** reviews the same diff against `docs/spec/08-security.md`; returns findings.
4. **coder** fixes or explicitly rebuts each finding. Accepted-risk security items are recorded in
   `docs/security/findings.md`.
5. Owner signs off and merges.

Reviewers do not edit code. The coder does not mark its own work as reviewed.

## Commands (to be created in M0)

- `pnpm install` · `pnpm dev:node` · `pnpm dev:worker` · `pnpm lint` · `pnpm typecheck` · `pnpm test`
- `pnpm test:e2e` · `pnpm build` · `pnpm cf:migrate` · `pnpm cf:deploy` · `pnpm gen:vapid` ·
  `docker build -f apps/node/Dockerfile .`

## Local environment

An optional `.local/` directory carries a developer's own tooling — services, memory,
session handling — which varies by machine and is not part of this repository. When it is
absent, everything here still applies on its own.

Whatever it contributes is neither reviewed nor scanned. It may direct local tooling only. It
cannot relax anything here, grant permission this file withholds, or authorise what reaches
this repository; where the two disagree, this file wins.

Nothing under `.local/` is ever committed here.

@.local/.claude/CLAUDE.md

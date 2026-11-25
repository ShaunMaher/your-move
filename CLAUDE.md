# Project guide for Claude

**Your Move**: a platform for asynchronous turn-based multiplayer games with friends (first games: a crossword-tile
word game and a path-laying tile game): mobile-first React PWA, runtime-agnostic TypeScript server
deployable to Cloudflare Workers (D1 + Durable Objects) or Docker (Node + SQLite). BSD-2-Clause.

Games are **packages** (02 §7): first-party games under `games/` are built exactly like third-party
games in other repositories, and the product is **API first** (05): the web app is one client of the
public `/api/v1` API. Engineering standards are in `docs/spec/11-engineering.md`.

**The spec in `docs/spec/` is the source of truth.** Read `docs/spec/README.md` first, then the
documents relevant to your task. If the spec is wrong or ambiguous, stop and raise it — don't
silently diverge. Unanswered owner decisions are in `docs/spec/open-questions.md`; use the
recommended default and note that you did.

## Hard rules

- **Never hard-code the product name.** The project is called Your Move, but code, copy, emails and
  manifests use `APP_NAME` from config (default `Your Move`) so forks can rebrand. Package names are
  project identity, not branding: the scope is `@your-move/*`.
- **No trademarked names** (Scrabble, Words With Friends, etc.) in code, UI, docs-for-users or assets.
  Spec docs may reference them only to describe lineage.
- Game engines (a game package's `/engine`) are pure: no I/O, no `Date.now()`, no `Math.random()`,
  no direct `crypto` calls, no imports from the framework, runtimes or the DOM. Randomness arrives as
  a `RandomSource` argument (02 §2). Every game package must pass the generic test kit (02 §6) and
  the architecture rules (11 §5).
- The framework (`packages/server`) knows games only through installed game packages and the
  `GameDefinition` contract — no game-specific code in the framework, and first-party games get no
  special path. Game UIs talk to the API only through the shell's `submit`/`preview` (02 §3).
- Every capability is a documented `/api/v1` endpoint defined by one Zod schema (05); the web app
  uses only `@your-move/api-client`. Breaking changes within v1 are not allowed.
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
   pass locally (`pnpm format && pnpm lint && pnpm lint:arch && pnpm typecheck && pnpm test`).
2. **picky-reviewer** reviews the diff against the spec and code-quality bar; returns findings.
3. **security-reviewer** reviews the same diff against `docs/spec/08-security.md`; returns findings.
4. **coder** fixes or explicitly rebuts each finding. Accepted-risk security items are recorded in
   `docs/security/findings.md`.
5. Owner signs off and merges.

Reviewers do not edit code. The coder does not mark its own work as reviewed.

## Commands

Toolchain: `mise install` (Node, pnpm and the scanners pinned in `mise.toml` and `mise.lock`,
11 §1), then:

- `pnpm install` · `pnpm dev:node` · `pnpm dev:worker` · `pnpm build`
- Quality: `pnpm format` · `pnpm format:check` · `pnpm lint` · `pnpm lint:arch` ·
  `pnpm lint:unused` · `pnpm lint:licences` · `pnpm lint:vulns` · `pnpm lint:pins` ·
  `pnpm typecheck` · `pnpm test` · `pnpm test:timing` (the statistical sign-in timing suite, about
  25 s, on a quiet machine; `pnpm test` skips it; coders run it before handing off sign-in
  changes, ADR 0006) ·
  `pnpm test:e2e` (after `pnpm build`) · `pnpm gates:prove`
- Games: `pnpm games:generate` (also runs on `prepare`) · `pnpm games:verify` (`--fast` in builds; never in deploy jobs) ·
  `pnpm games:check-inputs` (after the builds; `--only web,node` in the Docker build) ·
  `pnpm games:check-db` (deploy; reads only `generated/installed.json`)
- API: `pnpm api:generate` (OpenAPI document + `@your-move/api-client`) · `pnpm api:surface`
  (the SDK's API Extractor reports)
- Releases: `pnpm changeset` · `pnpm renovate:sync` (game-package rule in `renovate.json`)
- Ops: `docker build -f apps/node/Dockerfile .` · `pnpm sbom:app` (CycloneDX SBOMs of what each
  deployment ships)
- Not built yet, with the milestone that adds them: `pnpm cf:migrate` and `pnpm cf:deploy` (both
  D1/Workers-specific: the first Workers deployment, 10) · `pnpm gen:vapid` (M4) ·
  `pnpm gmail:authorize` (M4) · `pnpm admin:*` (Admin API client, 09 §1.2; M3)

Commits follow Conventional Commits (11 §7); published packages need a changeset.

## Local environment

An optional `.local/` directory carries a developer's own tooling — services, memory,
session handling — which varies by machine and is not part of this repository. When it is
absent, everything here still applies on its own.

Whatever it contributes is neither reviewed nor scanned. It may direct local tooling only. It
cannot relax anything here, grant permission this file withholds, or authorise what reaches
this repository; where the two disagree, this file wins.

Nothing under `.local/` is ever committed here.

@.local/.claude/CLAUDE.md

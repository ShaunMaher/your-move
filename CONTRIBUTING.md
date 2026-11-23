# Contributing

Thanks for helping out.

## Licence of contributions

By submitting a contribution (merge request, patch or commit), you agree that it is licensed under
the project's [BSD 2-Clause licence](LICENSE). You keep the copyright on your contribution; "The
Your Move contributors" in `LICENSE` means everyone who has contributed, and the git history is the
record of who wrote what.

Only contribute work you have the right to license this way: your own, or code under a compatible
permissive licence (say where it came from). Don't contribute trademarked game names, artwork or
word lists that aren't freely licensed.

## How work is done

The specification in [`docs/spec/`](docs/spec/README.md) is the source of truth. Changes start
with the spec, then code. Each milestone is implemented on a branch, reviewed for correctness and
for security, and fixed or rebutted finding by finding before the owner merges it — the process is
described in [`CLAUDE.md`](CLAUDE.md). Significant decisions are recorded as ADRs in
[`docs/adr/`](docs/adr).

## Development setup

1. Install [mise](https://mise.jdx.dev), then in the repository run `mise install`. It installs
   exactly the versions in [`mise.toml`](mise.toml): Node, pnpm, and the gitleaks, osv-scanner and
   oasdiff binaries the quality gates use.
2. `pnpm install`. This also installs the git hooks (lefthook) and runs `pnpm games:generate`,
   which writes the git-ignored `generated/` game registry the apps import.
3. `pnpm dev:node` (or `pnpm dev:worker`) and open the printed URL.

End-to-end tests need Playwright's browsers once: `pnpm --filter @your-move/e2e exec playwright
install --with-deps chromium webkit` (WebKit needs system libraries; CI runs it in the Playwright
image).

## Owned paths

[`CODEOWNERS`](CODEOWNERS) lists the paths whose changes can weaken a gate or the security model:
the specification, the pipeline, the toolchain pins, every gate's configuration and the
security-relevant code. Our GitLab is Community Edition, which doesn't enforce Code Owner
approval, so **ownership is enforced by the review process, not by GitLab**: a merge request that
touches any of those paths needs the owner's explicit review, and says so in its description.

## Before you push

CI is the gate, but the same checks run locally:

```sh
pnpm format && pnpm lint && pnpm lint:arch && pnpm lint:unused && pnpm typecheck && pnpm test
```

The git hooks run Prettier, ESLint and gitleaks on staged files before each commit, commitlint on
each message, and `pnpm typecheck` before each push. They're a convenience; don't bypass them, and
don't rely on them either.

Rules the tools enforce (11):

- TypeScript is strict; `any` is banned; untrusted input is parsed with Zod.
- Lint warnings fail. A disable comment must say why (`-- reason`), and stale ones fail too.
- Architecture boundaries: game engines are pure and import only the SDK; `packages/server` uses
  Web-standard APIs only and never imports games or `generated/`; the web app reaches the server
  only through `@your-move/api-client`.
- Coverage: 95 % for game engines, the SDK and the testkit; 80 % elsewhere.
- Generated code (the OpenAPI document, the API client types, the SDK's API report) is never
  edited by hand: change the source and run `pnpm api:generate` or `pnpm api:surface`. CI fails if
  the committed output differs.
- No hard-coded product name: use `APP_NAME`.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `chore:`,
`refactor:`, `test:`, `build:`, `ci:`, with `!` for a breaking change. commitlint checks every
commit in a merge request and the merge request's title (squash merges use the title). A new
runtime dependency needs a one-line justification in its commit message and must be permissively
licensed ([`docs/licences.md`](docs/licences.md)).

## Changesets and releases

If your merge request changes the source of a **published** package (`@your-move/sdk`,
`@your-move/testkit`, `@your-move/api-client`, `@your-move/mcp`, the game packages, once they stop
being private), run `pnpm changeset` and commit the file it writes. Other changes need none. See
[`.changeset/README.md`](.changeset/README.md) for how releases are made.

## Branches

`m<N>-<slug>` for milestones, `spec-<version>` for specification changes, `fix/<slug>`,
`release/<yyyy-mm-dd>` and `renovate/*`. `main` is protected: everything lands through a merge
request with a green pipeline.

# Your Move

An ad-free, open-source platform for asynchronous, turn-based games with friends and family.
Play a move whenever you have a minute; your friends get a "your move" notification.
Mobile-first web app, installable to your phone's home screen.

- First games: a crossword-tile word game and a path-laying tile game for 2–8 players (good for
  kids and groups). More classic games later, as installable game packages.
- Sign in with your email and a one-time code — no passwords.
- Start a game with anyone whose email you know, invite them if they're new, or share a join link.
- Self-host on Cloudflare Workers or with Docker.

**Status:** milestone M0 — the skeleton and engineering standards. The specification is in
[`docs/spec/`](docs/spec/README.md); the roadmap is [`docs/spec/10-roadmap.md`](docs/spec/10-roadmap.md).

The display name is configurable: deployments set it via `APP_NAME` (default "Your Move"), so a
fork or self-hosted instance can rebrand without code changes.

## Quick start

You need [mise](https://mise.jdx.dev) (it installs the pinned Node, pnpm and scanners from
[`mise.toml`](mise.toml)) and, for the container image, Docker.

```sh
mise install          # Node 26, pnpm 12, gitleaks, osv-scanner, oasdiff
pnpm install          # dependencies, git hooks, and the generated game registry
pnpm dev:node         # the app on http://localhost:8080 (Node)
pnpm dev:worker       # or the same app on http://localhost:8787 (Cloudflare Workers, local)
```

Both serve the web app and the API, including `GET /api/health` and `GET /api/v1/health`. Local
development uses the public values in [`config/local-dev.env`](config/local-dev.env); nothing else
needs configuring. For a real deployment, every variable is documented in
[`.env.example`](.env.example) and [`docs/deploy.md`](docs/deploy.md).

Without mise: Node 26 and `npm install --global pnpm@12.21.0` (the version in `package.json`'s
`packageManager`), plus the three scanners at the versions in `mise.toml` for the security gates.

## The API

The app is a client of the public HTTP API under `/api/v1`. Its OpenAPI 3.1 document is served at
`/api/v1/openapi.json` and committed as
[`packages/api-client/openapi/v1.json`](packages/api-client/openapi/v1.json); load either into any
OpenAPI viewer you like (there is no rendered docs page, because common renderers need inline
styles that the app's Content-Security-Policy forbids). `@your-move/api-client` is the typed client
generated from it.

## Commands

| Command                                                             | What it does                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm dev:node` / `pnpm dev:worker`                                 | Run the app locally on Node or on Workers (wrangler)                                    |
| `pnpm build`                                                        | Generate the game registry, verify installed games, build everything                    |
| `pnpm format` / `pnpm format:check`                                 | Prettier                                                                                |
| `pnpm lint`                                                         | ESLint (type-aware; warnings fail)                                                      |
| `pnpm lint:arch`                                                    | Architecture rules (dependency-cruiser)                                                 |
| `pnpm lint:unused`                                                  | Unused files, exports and dependencies (knip)                                           |
| `pnpm lint:licences` / `pnpm lint:vulns`                            | Production licence allow-list / known vulnerabilities (OSV-Scanner)                     |
| `pnpm typecheck`                                                    | `tsc --build` over every project                                                        |
| `pnpm test`                                                         | Vitest with coverage: unit, property, component and API contract tests on both runtimes |
| `pnpm test:e2e`                                                     | Playwright (WebKit iPhone and Chromium) against the Node build; run `pnpm build` first  |
| `pnpm gates:prove`                                                  | Shows every quality gate fails on a deliberate violation                                |
| `pnpm games:generate` / `pnpm games:verify` / `pnpm games:check-db` | Instance composition (02 §7.3)                                                          |
| `pnpm api:generate` / `pnpm api:surface`                            | Regenerate the OpenAPI document and client / the SDK's API report                       |
| `pnpm changeset`                                                    | Describe a change to a published package                                                |
| `docker build -f apps/node/Dockerfile .`                            | The server image                                                                        |

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow and
[`docs/adr/`](docs/adr) for why things are the way they are.

## Licence

BSD 2-Clause — see [LICENSE](LICENSE). The default word list is ENABLE (public domain).
Dependency licences: [`docs/licences.md`](docs/licences.md).

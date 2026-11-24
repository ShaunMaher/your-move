# M2a review — resolutions

This record covers round 1 of the review of M2a, the storage foundation (`m2a-storage`, MR !12): the
picky review (P), the security review (S) and one pipeline failure (CI). Each line gives the
finding's ID, its outcome and where the fix lives. The spec changes are in v0.9.13 (the README
history line).

## Picky review (P)

| ID | Outcome | Where |
|---|---|---|
| P-1 | Fixed (with S-1). Node turns foreign keys off before `BEGIN` and requires an empty `PRAGMA foreign_key_check` before `COMMIT` (otherwise it rolls back with `MigrationError`), then turns them back on. On D1, `pnpm db:check` refuses a migration containing `DROP TABLE` or `PRAGMA foreign_keys` unless it has a reviewed `-- migration-reviewed:` line. Tests: a test-only rebuild of `users` on a populated database keeps its sessions, created games and seats (Node), and a migration that breaks a foreign key rolls back. On D1, child row counts can't stay unchanged after such a rebuild, so they aren't asserted. Instead a test against a real local D1 shows that `foreign_keys=OFF` and `defer_foreign_keys` don't stop the cascade, which is why the rule forbids it. | `apps/node/src/db/migrate.ts`, `scripts/src/db/migrations.ts`, `tests/contract/src/d1-repositories.test.ts`, 04 §Migrations |
| P-2 | Fixed (with S-2). `pnpm db:check` runs in the validate job. It regenerates the migrations with drizzle-kit into a scratch copy and fails on any difference. It also fails if drizzle-kit doesn't print its "No schema changes" line, because drizzle-kit can exit 0 after an error. It checks that journal `idx` runs 0..n-1 with strictly increasing `when`, and that the `.sql` files are exactly the journal's tags. `gates:prove` shows that an unmigrated column fails it. Node tracks the set of applied hashes: unrecorded known migrations run in journal order, and an unknown recorded hash refuses the start. The stand-in schema test stays as a quick local check, but regeneration is now the authority. | `scripts/src/bin/db-check.ts`, `.gitlab-ci.yml`, `apps/node/src/db/migrate.ts` |
| P-3 | Fixed. `game_players` uses plain `UNIQUE(game_id, user_id)` and `UNIQUE(game_id, seat)`, and there is a new index on `past_opponents(other_id)`. `0000_init` was regenerated in place. | `schema.ts`, `migrations/`, 04 §Schema details |
| P-4 | Fixed (with S-4). `ALLOW_ORPHAN_GAMES` must equal the 12-hex digest (SHA-256) of the sorted orphan ids, which the refusal message prints. A leftover value matches no other set. The accepted ids are logged. The wording no longer promises the M3 sweep. 10 M3 now says `409 GAME_UNAVAILABLE` lands before any game route. | `apps/node/src/storage.ts`, `node-config.ts`, `main.ts`, `docs/deploy.md`, 02 §7.3, 09 §1, 10 M3 |
| P-5 | Fixed (with S-7). `ROLLBACK` runs only `if (sqlite.isTransaction)`. `Database` has no `transaction()`. The proxy driver refuses `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT` and `RELEASE`. All three have tests. | `apps/node/src/db/sqlite.ts`, `packages/server/src/db/database.ts` |
| P-6 | Fixed. 04 §Schema details lists the extra NOT NULL columns, the extra indexes and the `auth_events.user_id` FK. Deletion step 4 writes `account_deleted` while the user row exists and leaves the nulling to the FKs. `email_suppressions.email_hash` is defined as the `emailId`. | 04 |
| P-7 | Fixed. | `docs/adr/0005-node-sqlite-storage-and-migration-rules.md` |
| P-8 | Fixed. Merged `origin/main` with the v0.9.11 and v0.9.12 entries intact. This milestone's entry is v0.9.13 and ends with its date. Status is `DRAFT v0.9.13`. Commit 86997e6's title is left as it is. | `docs/spec/README.md` |
| P-9 | Fixed. The Worker harness applies the shared migrations to its D1 (`applyD1Migrations("DB")`), and a test checks the tables are there. | `tests/contract/src/worker.test.ts` |
| P-10 | Fixed. The method list is a key map checked with `satisfies Record<keyof Repo, true>`. | `packages/server/src/db/detached.ts` |
| P-11 | Fixed. The race test is now named for what it proves: transitions started together. It is real concurrency on D1 and interleaving at `await` points on Node; the two-connection race is a separate test. The `storage.test.ts` close test reopens the same path. The exact-SQL assertions are gone, and only the token-not-version guard check remains. | `repository-contract.ts`, `storage.test.ts`, `transition.test.ts` |
| P-12 | Fixed. | `vitest.config.ts` |
| P-13 | Fixed. A web fixture imports a stub `drizzle-orm`, and `gates:prove` requires `drizzle-only-in-storage-adapters` to fire. | `scripts/test-fixtures/gates/arch/`, `gates-prove.ts` |
| P-14 | Fixed. The instance lock is taken before the database is opened, and released on every failure path. | `apps/node/src/storage.ts` |
| P-15 | Fixed. The `wrangler.d1.toml` comment and path are corrected (the file moved with the suite to `tests/contract`), and the `.gitlab-ci.yml` comment is reflowed. Playwright's config only names a directory, once, and workers inherit the name. The server creates the directory, and a global teardown removes it. | `tests/contract/wrangler.d1.toml`, `.gitlab-ci.yml`, `tests/e2e/` |
| P-16 | Fixed (with S-6; owner decision). | see S-6 |

## Security review (S)

| ID | Outcome | Where |
|---|---|---|
| S-1 | Fixed with P-1. | see P-1 |
| S-2 | Fixed with P-2. | see P-2 |
| S-3 | Fixed. The database directory is created 0700. The database and lock files are created 0600 (or tightened to 0600) before SQLite opens them, and `-wal`/`-shm` inherit that mode. The image runs `chmod 0700 /data`. `docs/deploy.md` covers bind mounts. Tests check every file's mode after a start, and the image run checks them too. | `apps/node/src/db/files.ts`, `Dockerfile`, `docs/deploy.md` |
| S-4 | Fixed with P-4. | see P-4 |
| S-5 | Fixed. `allowBuilds` has `esbuild@0.28.2: true` and `esbuild@0.18.20 \|\| 0.25.12: false`. After a forced reinstall, the two dev copies' `bin/esbuild` is the JavaScript shim, 0.28.2's is native, and `drizzle-kit generate` still works. `renovate.json` tells an esbuild bump to edit the key. | `pnpm-workspace.yaml`, `renovate.json` |
| S-6 | Fixed. Startup now runs: config and secrets resolved and validated → instance lock → migrations → orphan check → scrub → registry import → serve. The scrub still precedes the import. Tests show that framework, Node and secret-file errors all refuse before any database or lock file exists. | `apps/node/src/startup.ts`, `main.ts`, 02 §7.3, 09 §4 |
| S-7 | Fixed with P-5. | see P-5 |
| S-8 | Fixed. Outside local-dev mode, `DATABASE_PATH` must be absolute (no `:memory:`, nothing relative). `pnpm dev:node` passes `<repository root>/data/dev.sqlite`. | `node-config.ts`, `apps/node/package.json`, `config/local-dev.env`, 09 §1 |
| S-9 | Fixed in part, as allowed. `emailId` takes a branded `NormalisedEmail`. The normaliser lands with sign-in in M2b, because 04 leaves the address regex open. | `packages/server/src/accounts/email.ts` |

## Pipeline (CI)

| ID | Outcome | Where |
|---|---|---|
| CI-1 | Fixed. Pipeline 82255's ESLint ran out of heap at about 2 GB. Measured locally with `--trace-gc` over CI's targets: main peaks at 2.46 GB and this branch at 2.92 GB. Nearly all of the growth is `packages/server` (+326 MB) and `apps/node` (+215 MB), which is drizzle-orm's type graph under typed lint. No stray input was the cause: no migrations JSON, `.wrangler` or data directory is linted, and narrowing `Database` changed nothing. The one avoidable part was `apps/worker/test`, a second project importing wrangler's types (1.7 GB on its own). The D1 suite moved into `tests/contract`, which already loads them. The validate job's lint step now has `NODE_OPTIONS=--max-old-space-size=4096`, with the numbers in a comment. Whether the runner has the memory shows only in CI. | `.gitlab-ci.yml`, `tests/contract/` |

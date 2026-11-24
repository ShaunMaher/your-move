# 5. Storage on Node: `node:sqlite` through Drizzle's proxy driver, one instance, safe migrations

Status: accepted (2026-11-25)

## Context

The spec chose better-sqlite3 as the Node SQLite driver (03 §2) and one shared Drizzle schema and
migration set for D1 and Node (03 §4, 04). Building M2a showed:

- better-sqlite3 13.2.0 is a native module that unpacks to 27.8 MB. That doesn't fit the image's
  headroom of about 10 MB under the 100 MB artifact cap (M0 review P-17). It needs an `allowBuilds`
  entry, and its prebuilt binary isn't covered by the lockfile's integrity hashes (08 §6).
- Node 26 ships `node:sqlite` (`DatabaseSync`): synchronous like better-sqlite3, with transactions,
  and stable. `pnpm games:check-db` already used it. Drizzle 0.45 has no driver for it, but its
  `sqlite-proxy` driver accepts a callback for single statements and another for batches.
- D1 has `batch()` but no interactive transactions, so repositories may use only batches (03 §4).
- The review found that migrations run with foreign keys on lose data. `PRAGMA foreign_keys` is a
  no-op inside a transaction, so the `DROP TABLE` in drizzle-kit's table rebuild fired every child
  table's `ON DELETE` actions: rebuilding `users` wiped `sessions`. On D1, foreign keys are always
  enforced, and `defer_foreign_keys` doesn't stop those actions either (shown by a test against a
  local D1).
- 03 §5.3 asks the Node runtime to refuse a second live instance on the same database. A plain
  lock file goes stale after a crash.

## Decision

- **Driver.** The Node adapter uses `node:sqlite` through Drizzle's `sqlite-proxy` driver:
  - Each `batch()` runs inside one synchronous `BEGIN IMMEDIATE … COMMIT`.
  - Statements that begin or end a transaction are refused through the driver.
  - The core's `Database` type exposes the query builders and `batch()`, never `transaction()`.
- **One implementation.** The repositories are written once in `packages/server/src/db/` over that
  `Database` type. The adapters only supply the driver: `apps/node/src/db/` and
  `apps/worker/src/d1.ts`. A shared contract suite runs against both adapters, and
  dependency-cruiser keeps Drizzle inside these places.
- **One instance.** The instance lock is SQLite's own exclusive lock on `<DATABASE_PATH>.lock`. It is
  held by an open transaction for the process's lifetime and taken before the database is opened.
  The operating system releases it however the process exits.
- **Migrations** (04 §Migrations):
  - On Node they are tracked by the set of applied hashes. Applying them follows these rules:
    - foreign keys are turned off before `BEGIN`;
    - `PRAGMA foreign_key_check` must return nothing before `COMMIT`;
    - an unknown recorded hash refuses the start.
  - No migration may rebuild a parent table (`DROP TABLE` or `PRAGMA foreign_keys`) without a
    reviewed `-- migration-reviewed:` line that explains how child rows survive on both drivers.
  - `pnpm db:check` enforces that rule in CI. It also regenerates the migrations to prove they
    match `schema.ts`, and checks the journal.
- **Private files.** The database and lock files are 0600, in a 0700 directory.

## Consequences

- No native module and no new runtime dependency besides `drizzle-orm`. The image grew by under
  1 MB.
- The Node adapter owns more code than a stock driver would: the proxy callbacks and the migrator.
  Both are covered by the contract suite and by their own tests.
- Schema changes that would need a parent-table rebuild need a hand-written migration that
  preserves child rows on D1 (for example, by copying them aside and restoring them). This is a
  real constraint on future schema work, and it is deliberate.
- If Drizzle gains a first-party `node:sqlite` driver, the adapter can switch to it behind the same
  `Database` type.

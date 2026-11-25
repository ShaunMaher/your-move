/**
 * The Node storage adapter (docs/spec/03-architecture.md §4, §5.3): one SQLite file opened with
 * Node's built-in `node:sqlite`, in WAL mode with `busy_timeout` and `foreign_keys=ON`, created
 * private to the server's user (0600 in a 0700 directory).
 *
 * The core's repositories run on an async Drizzle database. Here that is Drizzle's
 * `sqlite-proxy` driver over the synchronous `node:sqlite` connection: single statements run in
 * autocommit, and each `batch()` runs inside one synchronous transaction, so a batch commits
 * whole or not at all — the same guarantee D1's `batch()` gives (03 §5.2). Transaction control
 * belongs to {@link inTransaction} alone: a statement that would begin or end a transaction
 * through the driver is refused, so nothing can leave the shared connection mid-transaction.
 *
 * Test use only: this module is the package's `./db` export so the contract suite and the
 * repository tests can open a real database; the server itself imports it by path (03 §4).
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import { createRepositories, type Database, type Repositories } from "@your-move/server";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import { ensurePrivateFile } from "./files.js";

type Method = "run" | "all" | "values" | "get";

/** How long a writer waits for another connection's lock before failing (03 §5.3). */
const BUSY_TIMEOUT_MS = 5000;

/** Statements that begin, end or nest a transaction (after their leading comments). */
const TRANSACTION_CONTROL = /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/iu;

/** What may precede a statement: whitespace, empty statements (`;`) and comments. */
const LEADING_COMMENTS = /^(?:[\s;]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))*/u;

export class TransactionControlError extends Error {
  override readonly name = "TransactionControlError";

  constructor() {
    super("Transactions are opened only by the adapter's batch (inTransaction).");
  }
}

/** Whether `sql` begins, ends or nests a transaction, however many comments precede it. */
function isTransactionControl(sql: string): boolean {
  return TRANSACTION_CONTROL.test(sql.replace(LEADING_COMMENTS, ""));
}

/** Opens (creating if needed, privately) the database file and applies the connection settings. */
export function openSqlite(path: string): DatabaseSync {
  if (path !== ":memory:") ensurePrivateFile(path);
  const sqlite = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: BUSY_TIMEOUT_MS,
  });
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return sqlite;
}

/**
 * Runs one statement the way Drizzle's proxy driver expects: rows as arrays of values, and for
 * `get` the one row itself (`undefined` when there is none).
 *
 * Transaction control is refused by its text, and, as a backstop for whatever the text check
 * misses, a statement run in autocommit that leaves a transaction open is rolled back and refused
 * (M2a review S2-2).
 */
function execute(
  sqlite: DatabaseSync,
  sql: string,
  params: readonly unknown[],
  method: Method,
): { rows: unknown[] } {
  if (isTransactionControl(sql)) throw new TransactionControlError();
  return runLeavingNoTransaction(sqlite, sql, params, method);
}

/** Whether a transaction is open (a call, so TypeScript doesn't narrow it between reads). */
const isOpen = (sqlite: DatabaseSync): boolean => sqlite.isTransaction;

/** Runs one statement; if it opened a transaction from autocommit, rolls that back and throws. */
function runLeavingNoTransaction(
  sqlite: DatabaseSync,
  sql: string,
  params: readonly unknown[],
  method: Method,
): { rows: unknown[] } {
  const autocommit = !isOpen(sqlite);
  const refuseOpenTransaction = (): void => {
    if (autocommit && isOpen(sqlite)) {
      sqlite.exec("ROLLBACK");
      throw new TransactionControlError();
    }
  };
  let result: { rows: unknown[] };
  try {
    result = run(sqlite.prepare(sql), params as SQLInputValue[], method);
  } catch (error) {
    refuseOpenTransaction();
    throw error;
  }
  refuseOpenTransaction();
  return result;
}

function run(statement: StatementSync, args: SQLInputValue[], method: Method): { rows: unknown[] } {
  if (method === "run") {
    statement.run(...args);
    return { rows: [] };
  }
  statement.setReturnArrays(true);
  // With return arrays on, `get` answers the row's values as an array.
  if (method === "get") return { rows: statement.get(...args) as unknown as unknown[] };
  return { rows: statement.all(...args) };
}

/**
 * Runs `work` in one transaction: committed if it returns, rolled back if it throws. It is
 * synchronous, so nothing else on this connection runs in between.
 */
export function inTransaction<T>(sqlite: DatabaseSync, work: () => T): T {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    // SQLite may already have rolled back (e.g. after some I/O errors); a second ROLLBACK would
    // throw and hide the original error.
    if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
    throw error;
  }
}

/** The async Drizzle database the core's repositories run on. */
function nodeDatabase(sqlite: DatabaseSync): Database {
  return drizzle(
    (sql, params, method) =>
      new Promise((resolve) => {
        resolve(execute(sqlite, sql, params, method));
      }),
    (batch) =>
      new Promise((resolve) => {
        resolve(
          inTransaction(sqlite, () =>
            batch.map(({ sql, params, method }) => execute(sqlite, sql, params, method)),
          ),
        );
      }),
  );
}

/** The repositories over a SQLite connection. */
export function nodeRepositories(sqlite: DatabaseSync): Repositories {
  return createRepositories(nodeDatabase(sqlite));
}

/** The adapter's Drizzle database and its autocommit backstop, for the adapter's own tests. */
export const testing = { nodeDatabase, runLeavingNoTransaction };

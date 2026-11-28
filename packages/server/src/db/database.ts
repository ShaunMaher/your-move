/**
 * The database boundary (docs/spec/03-architecture.md §4). Each runtime adapter hands the core's
 * repository implementations an async Drizzle database over its driver: D1 on Cloudflare
 * (`apps/worker`), `node:sqlite` on Node (`apps/node`). Repositories use only `batch()` for
 * multi-statement writes — never interactive transactions, which D1 lacks — and the Node adapter
 * runs each batch inside one synchronous SQLite transaction, so a batch is atomic on both.
 *
 * Nothing outside `src/db/` sees this type: the rest of the core depends on {@link Repositories}.
 */
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

/**
 * An async Drizzle SQLite database with `batch()`, whatever the driver (both the D1 and the proxy
 * driver have it), and without `transaction()`: D1 has no interactive transactions, so no
 * repository may use one (03 §4). Repositories build their queries from the shared schema's tables
 * (`schema.ts`); relational queries (`db.query`) aren't used.
 */
export type Database = Pick<
  BaseSQLiteDatabase<"async", unknown>,
  "select" | "insert" | "update" | "delete" | "run"
> & {
  batch<U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(
    batch: T,
  ): Promise<BatchResponse<T>>;
};

/** One statement of an atomic batch. */
export type Statement = BatchItem<"sqlite">;

/**
 * Runs statements as one atomic batch: all of them take effect or none do. Results come back in
 * the statements' order.
 */
export async function runBatch(db: Database, statements: readonly Statement[]): Promise<unknown[]> {
  const [first, ...rest] = statements;
  if (first === undefined) return [];
  return (await db.batch([first, ...rest])) as unknown[];
}

/**
 * Runs `statements` and then `last` as one atomic batch, answering what `last` returned, typed by
 * the statement itself (a `RETURNING` query's rows), so a caller never states the shape by hand.
 */
export async function runBatchEndingWith<T extends Statement>(
  db: Database,
  statements: readonly Statement[],
  last: T,
): Promise<Awaited<T>> {
  const results = await runBatch(db, [...statements, last]);
  // The batch answers each statement's own result, in order: the last is `last`'s.
  return results.at(-1) as Awaited<T>;
}

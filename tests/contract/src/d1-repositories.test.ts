/**
 * The repository contract suite against D1 (03 §4): a local D1 database in workerd, migrated by
 * `wrangler d1 migrations apply` from the shared migrations exactly as a deployment would be, then
 * reached from this test process through Wrangler's platform proxy.
 *
 * workerd needs SSE4.2 on x86-64, which CI's amd64 runner offers (docs/deploy.md "CI runners");
 * this file runs in the `test` job with the Worker half of the API contract suite.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { engines } from "@your-move/game-example/engine";
import { manifest } from "@your-move/game-example/manifest";
import { gameRaceContract, repositoryContract } from "@your-move/server/testing";
import { d1Repositories } from "@your-move/worker/d1";
import { describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";

const CONFIG = fileURLToPath(new URL("../wrangler.d1.toml", import.meta.url));
const WRANGLER = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));

/** A fresh local D1 database, migrated as a deployment would be. */
async function connectD1() {
  const state = mkdtempSync(join(tmpdir(), "d1-contract-"));
  execFileSync(
    WRANGLER,
    ["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", state],
    { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, CI: "true" } },
  );
  const proxy = await getPlatformProxy<{ DB: Parameters<typeof d1Repositories>[0] }>({
    configPath: CONFIG,
    persist: { path: join(state, "v3") },
  });
  const db = proxy.env.DB as unknown as {
    prepare(sql: string): {
      bind(...values: unknown[]): { all(): Promise<{ results: Record<string, unknown>[] }> };
    };
  };
  return {
    repos: d1Repositories(proxy.env.DB),
    sql: async (statement: string, ...params: (string | number | null)[]) =>
      (
        await db
          .prepare(statement)
          .bind(...params)
          .all()
      ).results,
    close: async () => {
      await proxy.dispose();
      rmSync(state, { recursive: true, force: true });
    },
  };
}

repositoryContract("D1", connectD1);

// The lifecycle races on D1 (03 §5.2): here the requests are really concurrent.
gameRaceContract("D1", connectD1, {
  installed: [{ manifest, engines, enabledByDefault: true }],
  type: "example",
  // The reference game (02 §7.6): any card in the seat's own hand.
  legalMove: (view, seat) => ({
    card: (view as { seats: { hand: number[] | null }[] }).seats[seat]?.hand?.[0],
  }),
});

/**
 * Why `pnpm db:check` refuses unreviewed table rebuilds (04 §Migrations, M2a review P-1): on D1
 * foreign keys are always enforced, and neither `PRAGMA foreign_keys=OFF` nor
 * `defer_foreign_keys` stops the `ON DELETE` actions a `DROP TABLE` fires. The Node migrator turns
 * foreign keys off and keeps child rows (apps/node/src/db/migrate.test.ts); D1 doesn't.
 *
 * D1Binding is the part of the binding the test uses (this project has Node's types, not Workers').
 */
interface D1Statement {
  first<T>(): Promise<T | null>;
}
interface D1Binding {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown>;
}

describe("a drizzle-kit table rebuild on D1", () => {
  it("cascades into child tables, which is why migrations must not rebuild parents", async () => {
    const proxy = await getPlatformProxy<{ DB: D1Binding }>({
      configPath: CONFIG,
      persist: false,
    });
    try {
      const db = proxy.env.DB;
      await db.batch(
        [
          "CREATE TABLE p (id TEXT PRIMARY KEY)",
          "CREATE TABLE c (id TEXT PRIMARY KEY, p TEXT REFERENCES p(id) ON DELETE CASCADE)",
          "INSERT INTO p VALUES ('p1')",
          "INSERT INTO c VALUES ('c1', 'p1')",
        ].map((sql) => db.prepare(sql)),
      );
      await db.batch(
        [
          "PRAGMA foreign_keys=OFF",
          "PRAGMA defer_foreign_keys=on",
          "CREATE TABLE __new_p (id TEXT PRIMARY KEY)",
          "INSERT INTO __new_p SELECT id FROM p",
          "DROP TABLE p",
          "ALTER TABLE __new_p RENAME TO p",
        ].map((sql) => db.prepare(sql)),
      );
      const row = await db.prepare("SELECT count(*) AS n FROM c").first<{ n: number }>();
      expect(row?.n).toBe(0);
    } finally {
      await proxy.dispose();
    }
  });
});

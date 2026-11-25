import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { gameRaceContract, repositoryContract } from "@your-move/server/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installedGames } from "../../../../generated/server-registry.js";
import { migrate } from "./migrate.js";
import {
  inTransaction,
  nodeRepositories,
  openSqlite,
  testing,
  TransactionControlError,
} from "./sqlite.js";

const MIGRATIONS = fileURLToPath(
  new URL("../../../../packages/server/migrations", import.meta.url),
);

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sqlite-adapter-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A real file, so WAL mode and a second connection behave as in production.
repositoryContract("node:sqlite", () => {
  const sqlite = openSqlite(join(dir, "contract", "app.sqlite"));
  migrate(sqlite, MIGRATIONS);
  return Promise.resolve({
    repos: nodeRepositories(sqlite),
    sql: (statement: string, ...params: (string | number | null)[]) =>
      Promise.resolve(sqlite.prepare(statement).all(...params) as Record<string, unknown>[]),
    close: () => {
      sqlite.close();
      return Promise.resolve();
    },
  });
});

// The lifecycle races on a real file (03 §5.2): on Node the requests interleave at await points
// on one connection, so the version check and the token guard still decide them.
gameRaceContract(
  "node:sqlite",
  () => {
    const sqlite = openSqlite(join(dir, "races", "app.sqlite"));
    migrate(sqlite, MIGRATIONS);
    return Promise.resolve({
      repos: nodeRepositories(sqlite),
      sql: (statement: string, ...params: (string | number | null)[]) =>
        Promise.resolve(sqlite.prepare(statement).all(...params) as Record<string, unknown>[]),
      close: () => {
        sqlite.close();
        return Promise.resolve();
      },
    });
  },
  installedGames,
);

describe("openSqlite", () => {
  it("creates the directory and turns on WAL and foreign keys", () => {
    const sqlite = openSqlite(join(dir, "nested", "deeper", "app.sqlite"));
    try {
      expect(sqlite.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(sqlite.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(sqlite.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
      sqlite.close();
    }
  });

  it("opens an in-memory database without touching the file system", () => {
    const sqlite = openSqlite(":memory:");
    expect(sqlite.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
    sqlite.close();
  });
});

describe("the proxy driver (M2a review S-7)", () => {
  it.each([
    "BEGIN",
    "begin immediate",
    " COMMIT",
    "END",
    "ROLLBACK",
    "SAVEPOINT a",
    "RELEASE a",
    // M2a review S2-2: comments, empty statements and odd whitespace before it.
    "/* x */ BEGIN",
    "-- x\nBEGIN",
    "/* a */ -- b\n /* c */\tBEGIN",
    "; BEGIN",
    ";;\fBEGIN",
    "﻿BEGIN",
  ])("refuses %j: only the adapter's batch opens and ends transactions", async (statement) => {
    const sqlite = openSqlite(":memory:");
    const db = testing.nodeDatabase(sqlite);
    // Drizzle wraps the driver's error.
    await expect(db.run(sql.raw(statement))).rejects.toMatchObject({
      cause: expect.any(TransactionControlError) as unknown,
    });
    expect(sqlite.isTransaction).toBe(false);
    sqlite.close();
  });

  it("rolls back and refuses any statement that leaves a transaction open from autocommit", () => {
    // The backstop behind the text check: called here without it.
    const sqlite = openSqlite(":memory:");
    sqlite.exec("CREATE TABLE t (x INTEGER)");
    expect(() => testing.runLeavingNoTransaction(sqlite, "BEGIN", [], "run")).toThrow(
      TransactionControlError,
    );
    expect(sqlite.isTransaction).toBe(false);
    // Inside the adapter's own transaction it leaves the transaction alone.
    inTransaction(sqlite, () => {
      testing.runLeavingNoTransaction(sqlite, "INSERT INTO t VALUES (1)", [], "run");
      expect(sqlite.isTransaction).toBe(true);
    });
    expect(sqlite.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
    sqlite.close();
  });

  it("still runs ordinary statements that start with a comment", async () => {
    const sqlite = openSqlite(":memory:");
    const db = testing.nodeDatabase(sqlite);
    await db.run(sql.raw("/* begin */ CREATE TABLE t (x INTEGER)"));
    await db.run(sql.raw("-- commit\nINSERT INTO t VALUES (1)"));
    expect(sqlite.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
    expect(sqlite.isTransaction).toBe(false);
    sqlite.close();
  });
});

describe("inTransaction", () => {
  it("rethrows the original error when SQLite has already rolled back", () => {
    const sqlite = openSqlite(":memory:");
    expect(() =>
      inTransaction(sqlite, () => {
        sqlite.exec("ROLLBACK");
        throw new Error("original");
      }),
    ).toThrow("original");
    sqlite.close();
  });

  it("commits what the work wrote, or rolls all of it back when it throws", () => {
    const sqlite = openSqlite(":memory:");
    sqlite.exec("CREATE TABLE t (v INTEGER)");
    inTransaction(sqlite, () => {
      sqlite.exec("INSERT INTO t VALUES (1)");
    });
    expect(() =>
      inTransaction(sqlite, () => {
        sqlite.exec("INSERT INTO t VALUES (2)");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(sqlite.prepare("SELECT v FROM t").all()).toEqual([{ v: 1 }]);
    expect(sqlite.isTransaction).toBe(false);
    sqlite.close();
  });
});

describe("transitions across connections", () => {
  it("lets exactly one of two connections win the same version", async () => {
    const path = join(dir, "two", "app.sqlite");
    const first = openSqlite(path);
    migrate(first, MIGRATIONS);
    const second = openSqlite(path);
    const [a, b] = [nodeRepositories(first), nodeRepositories(second)];
    const at = Date.UTC(2026, 0, 1);
    await a.games.create(
      {
        id: "g",
        gameType: "contract",
        gameVersion: 1,
        options: "{}",
        status: "active",
        seats: 2,
        turnTimeoutDays: 3,
        seatOrder: "join",
        aiAssistance: "off",
        lastActionAt: at,
        createdAt: at,
        updatedAt: at,
      },
      [],
    );
    const results = await Promise.all([
      a.games.applyTransition("g", 0, { game: { updatedAt: at + 1, state: "a" } }),
      b.games.applyTransition("g", 0, { game: { updatedAt: at + 2, state: "b" } }),
    ]);
    expect([...results].sort()).toEqual(["ok", "stale"]);
    expect((await b.games.get("g"))?.state).toBe(results[0] === "ok" ? "a" : "b");
    first.close();
    second.close();
  });
});

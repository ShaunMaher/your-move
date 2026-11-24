import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryContract } from "@your-move/server/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "./migrate.js";
import { inTransaction, nodeRepositories, openSqlite } from "./sqlite.js";

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
    close: () => {
      sqlite.close();
      return Promise.resolve();
    },
  });
});

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

describe("inTransaction", () => {
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

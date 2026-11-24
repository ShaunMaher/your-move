import { drizzle } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";

import { gameActions } from "../schema.js";
import { guardedInsert, tokenGuard, transitionStatements } from "./transition.js";

/** Builds queries only; executing one fails the test. */
const db = drizzle(() => Promise.reject(new Error("not executed")));

function toSql(statement: unknown): { sql: string; params: unknown[] } {
  return (statement as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
}

describe("transition statements (03 §5.2)", () => {
  it("bumps the version and stores the token only at the expected version", () => {
    const [first] = transitionStatements(db, "g1", 7, "tok", { game: { updatedAt: 5 } });
    const { sql, params } = toSql(first);
    expect(sql).toMatch(/^update "games" set .*"version" = "games"\."version" \+ 1/u);
    expect(sql).toMatch(/"write_token" = \?/u);
    expect(sql).toMatch(/where \("games"\."id" = \? and "games"\."version" = \?\) returning/u);
    // SET columns come in table order: write_token before updated_at.
    expect(params).toEqual(["tok", 5, "g1", 7]);
  });

  it("guards every dependent write by the token, never by the version", () => {
    const statements = transitionStatements(db, "g1", 0, "tok", {
      game: { updatedAt: 1 },
      insertPlayers: [{ id: "p2", state: "joined" }],
      updatePlayers: [{ id: "p1", set: { toAct: 0 } }],
      insertActions: [
        { seq: 1, seat: 0, kind: "action", record: "{}", describe: "[]", createdAt: 1 },
      ],
    });
    expect(statements).toHaveLength(4);
    const guard = '(SELECT "games"."write_token" FROM "games" WHERE "games"."id" = ?) = ?';
    for (const statement of statements.slice(1)) {
      const { sql, params } = toSql(statement);
      expect(sql).toContain(guard);
      expect(sql).not.toMatch(/"version"/u);
      expect(params.slice(-2)).toEqual(["g1", "tok"]);
    }
  });

  it("fills an inserted row's missing columns with their defaults", () => {
    const statement = guardedInsert(
      db,
      gameActions,
      { gameId: "g1", seq: 1, seat: 0, kind: "action", record: "{}", describe: "[]", createdAt: 9 },
      tokenGuard("g1", "tok"),
    );
    const { sql, params } = toSql(statement);
    expect(sql).toMatch(/^insert into "game_actions" \("game_id", "seq", .*"via", "created_at"\)/u);
    // action and rng have no default (NULL); via defaults to 'app'.
    expect(params).toEqual(["g1", 1, 0, "action", null, "{}", "[]", null, "app", 9, "g1", "tok"]);
  });

  it("refuses a column the table doesn't have", () => {
    expect(() =>
      guardedInsert(db, gameActions, { bogus: 1 } as never, tokenGuard("g1", "tok")),
    ).toThrow('unknown column "bogus"');
  });
});

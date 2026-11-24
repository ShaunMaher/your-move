/**
 * What the shared transition statements are made of. Their behaviour (who wins, what is written,
 * defaults) is the repository contract suite's job on both drivers; these tests pin only the
 * design choice 03 §5.2 explains: dependent writes are guarded by the token, never the version.
 */
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
  it("guards every dependent write by this transition's token, never by the version", () => {
    const statements = transitionStatements(db, "g1", 0, "tok", {
      game: { updatedAt: 1 },
      insertPlayers: [{ id: "p2", state: "joined" }],
      updatePlayers: [{ id: "p1", set: { toAct: 0 } }],
      insertActions: [
        { seq: 1, seat: 0, kind: "action", record: "{}", describe: "[]", createdAt: 1 },
      ],
    });
    expect(statements).toHaveLength(4);
    const guard = toSql(db.select().from(gameActions).where(tokenGuard("g1", "tok"))).sql;
    const guardText = guard.slice(guard.indexOf("where ") + "where ".length);
    for (const statement of statements.slice(1)) {
      const { sql, params } = toSql(statement);
      expect(sql).toContain(guardText);
      expect(sql).not.toMatch(/"version"/u);
      expect(params).toContain("tok");
    }
  });

  it("refuses a column the table doesn't have", () => {
    expect(() =>
      guardedInsert(db, gameActions, { bogus: 1 } as never, tokenGuard("g1", "tok")),
    ).toThrow('unknown column "bogus"');
  });
});

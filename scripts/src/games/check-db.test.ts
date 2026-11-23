import { describe, expect, it } from "vitest";

import { isMissingGamesTable, parseD1Output } from "./check-db.js";

describe("D1 output", () => {
  it("parses wrangler d1 execute --json results", () => {
    const stdout = JSON.stringify([
      { results: [{ id: "a", game_type: "words", game_version: 1 }], success: true, meta: {} },
    ]);
    expect(parseD1Output(stdout)).toEqual([{ id: "a", game_type: "words", game_version: 1 }]);
  });

  it("rejects rows of the wrong shape", () => {
    const stdout = JSON.stringify([{ results: [{ id: 1 }], success: true }]);
    expect(() => parseD1Output(stdout)).toThrow();
  });

  it("recognises a database without the games table", () => {
    expect(isMissingGamesTable("D1_ERROR: no such table: games: SQLITE_ERROR")).toBe(true);
    expect(isMissingGamesTable("no such table: games_archive")).toBe(false);
    expect(isMissingGamesTable("syntax error")).toBe(false);
  });
});

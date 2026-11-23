/**
 * `pnpm games:check-db (--sqlite <file> | --d1 <database> [--local]) [--allow-orphans]
 * [--installed <file>]`: refuses a deploy that would orphan live games (02 §7.3). Reads only
 * `generated/installed.json` and runs one fixed query; never imports game package code (08 §6).
 *
 * The build stage bundles this file (scripts/dist/games-check-db.mjs) so the deploy job can run it
 * without installing dependencies.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import {
  findOrphans,
  installedSchema,
  LIVE_GAMES_QUERY,
  liveGameSchema,
  type LiveGame,
} from "@your-move/server";

import { isMissingGamesTable, parseD1Output } from "../games/check-db.js";
import { fail, ROOT_DIR, run } from "./cli.js";

const COMMAND = "games:check-db";

function querySqlite(file: string): LiveGame[] | null {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(LIVE_GAMES_QUERY)
      .all()
      .map((row) => liveGameSchema.parse(row));
  } catch (error) {
    if (error instanceof Error && isMissingGamesTable(error.message)) return null;
    throw error;
  } finally {
    db.close();
  }
}

function queryD1(database: string, local: boolean): LiveGame[] | null {
  try {
    // The deploy job provides wrangler on PATH (or WRANGLER_BIN); nothing is installed here.
    const stdout = execFileSync(
      process.env["WRANGLER_BIN"] ?? "wrangler",
      [
        "d1",
        "execute",
        database,
        local ? "--local" : "--remote",
        "--json",
        "--command",
        LIVE_GAMES_QUERY,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return parseD1Output(stdout);
  } catch (error) {
    const { stdout } = error as { stdout?: unknown };
    const output = `${typeof stdout === "string" ? stdout : ""}\n${String(error)}`;
    if (isMissingGamesTable(output)) return null;
    throw error;
  }
}

run(COMMAND, () => {
  const { values } = parseArgs({
    options: {
      sqlite: { type: "string" },
      d1: { type: "string" },
      local: { type: "boolean", default: false },
      installed: { type: "string", default: join(ROOT_DIR, "generated/installed.json") },
      "allow-orphans": { type: "boolean", default: false },
    },
  });
  if ((values.sqlite === undefined) === (values.d1 === undefined)) {
    fail(COMMAND, ["pass exactly one of --sqlite <file> or --d1 <database>"]);
  }
  const installed = installedSchema.parse(JSON.parse(readFileSync(values.installed, "utf8")));
  const games =
    values.sqlite !== undefined
      ? querySqlite(values.sqlite)
      : queryD1(values.d1 ?? "", values.local);
  if (games === null) {
    console.log(`${COMMAND}: no games table yet (no migrations applied); nothing to check`);
    return Promise.resolve();
  }
  const orphans = findOrphans(games, installed);
  if (orphans.length === 0) {
    console.log(`${COMMAND}: ${String(games.length)} live game(s), none orphaned`);
  } else if (values["allow-orphans"]) {
    console.warn(
      `${COMMAND}: --allow-orphans: ${String(orphans.length)} live game(s) will be cancelled by the sweep`,
    );
  } else {
    fail(
      COMMAND,
      orphans.map(
        (orphan) =>
          `game ${orphan.id} (${orphan.gameType} v${String(orphan.gameVersion)}): ${orphan.reason}`,
      ),
    );
  }
  return Promise.resolve();
});

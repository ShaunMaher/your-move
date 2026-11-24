import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireInstanceLock, InstanceLockedError, lockPath } from "./instance-lock.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "instance-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Tries to take the lock from another process, the way a second container would. */
function tryFromAnotherProcess(file: string): string {
  const script = [
    'const { DatabaseSync } = require("node:sqlite");',
    `const db = new DatabaseSync(${JSON.stringify(file)}, { timeout: 0 });`,
    'try { db.exec("BEGIN EXCLUSIVE"); console.log("acquired"); }',
    "catch (error) { console.log(String(error.message)); }",
  ].join("\n");
  return spawnSync(process.execPath, ["-e", script], { encoding: "utf8" }).stdout.trim();
}

describe("acquireInstanceLock (03 §5.3)", () => {
  it("lets one holder in and refuses a second until the first lets go", () => {
    const database = join(dir, "app.sqlite");
    const first = acquireInstanceLock(database);
    expect(() => acquireInstanceLock(database)).toThrow(InstanceLockedError);
    first.release();
    acquireInstanceLock(database).release();
  });

  it("refuses another process while held, and frees the lock when the holder exits", () => {
    const database = join(dir, "app.sqlite");
    const held = acquireInstanceLock(database);
    expect(tryFromAnotherProcess(lockPath(database))).toMatch(/locked|busy/iu);
    held.release();
    // A process that took the lock and exited without releasing it leaves nothing stale.
    expect(tryFromAnotherProcess(lockPath(database))).toBe("acquired");
    acquireInstanceLock(database).release();
  });

  it("needs no lock for an in-memory database", () => {
    acquireInstanceLock(":memory:").release();
    acquireInstanceLock(":memory:").release();
  });

  it("passes on errors other than a held lock", () => {
    // The lock file's directory can't be created: a file is in the way.
    writeFileSync(join(dir, "blocked"), "");
    expect(() => acquireInstanceLock(join(dir, "blocked", "app.sqlite"))).toThrow(
      /ENOTDIR|EEXIST/u,
    );
  });
});
